import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0032 (ADR 0017 slice S1): tenants.settings, draft revisions, reviews and decisions,
 * and the granted_by columns of team and agent bindings. Runs on PGlite and, with
 * OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0032_agent_lifecycle_reviews';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');
const HEX = (c: string) => c.repeat(64);

describe('migration 0032 files', () => {
  it('follows 0031 in the journal, is newer than every earlier migration, and chains its snapshot', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(journal.entries[at - 1]!.tag).toBe('0031_tenant_use_case_attach');
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(whens[at]!).toBeGreaterThan(1_792_700_000_000);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0032').prevId).toBe(read('0031').id);
    expect(Object.keys(read('0032').tables)).toEqual(
      expect.arrayContaining([
        'public.agent_draft_revisions',
        'public.agent_reviews',
        'public.agent_review_decisions',
      ]),
    );
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0032 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const other = randomUUID();
  const agent = randomUUID();
  const foreignAgent = randomUUID();
  const user = randomUUID();
  const team = randomUUID();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    c = await open();
    await c.migrate(dir);
    await c.query(
      `insert into tenants (id, slug, name, root_id, path, depth) values ($1, 'other', 'other', $1, $2, 0)`,
      [other, `/${other}/`],
    );
    await c.query(
      `insert into users (id, email, display_name, source, tenant_id) values ($1, 'u@example.org', 'U', 'local', $2)`,
      [user, root],
    );
    await c.query(`insert into teams (id, tenant_id, slug, name) values ($1, $2, 't', 'T')`, [
      team,
      root,
    ]);
    await c.query(`insert into team_members (team_id, user_id, role) values ($1, $2, 'viewer')`, [
      team,
      user,
    ]);
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'a', 'x')`,
      [agent, root],
    );
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'f', 'x')`,
      [foreignAgent, other],
    );
    await c.query(
      `insert into agent_role_bindings (user_id, agent_id, role) values ($1, $2, 'viewer')`,
      [user, agent],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const revision = (
    id: string,
    agentId: string,
    tenantId: string,
    seq: number,
    extra: Partial<Record<string, unknown>> = {},
  ) =>
    c.query(
      `insert into agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_id, author_kind)
       values ($1, $2, $3, $4, $5, 'src', $6, $7)`,
      [
        id,
        agentId,
        tenantId,
        seq,
        HEX('a'),
        'authorId' in extra ? extra.authorId : user,
        extra.authorKind ?? 'user',
      ],
    );
  const review = (id: string, agentId: string, tenantId: string, revisionId: string) =>
    c.query(
      `insert into agent_reviews (id, agent_id, tenant_id, opened_by, opened_revision_id, policy_snapshot, policy_digest, required_approvals)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 1)`,
      [id, agentId, tenantId, user, revisionId, HEX('b')],
    );
  const decision = (id: string, reviewId: string, revisionId: string, kind = 'approve') =>
    c.query(
      `insert into agent_review_decisions (id, review_id, revision_id, digest, expansion_digest, resolution_digest, policy_digest,
         reviewer_id, reviewer_auth, acting_tenant_id, binding_refs, decision, expires_at)
       values ($1, $2, $3, $4, $4, $4, $4, $5, 'session', $6, '[]'::jsonb, $7, ${kind === 'approve' ? "now() + interval '1 day'" : 'null'})`,
      [id, reviewId, revisionId, HEX('c'), user, root, kind],
    );

  it('keeps existing rows and adds the new columns empty', async () => {
    expect((await c.query(`select settings from tenants where id = $1`, [root])).rows[0]).toEqual({
      settings: {},
    });
    expect(
      (await c.query(`select draft_revision_id from agents where id = $1`, [agent])).rows[0],
    ).toEqual({
      draft_revision_id: null,
    });
    expect((await c.query(`select granted_by from team_members`)).rows[0]).toEqual({
      granted_by: null,
    });
    expect((await c.query(`select granted_by from agent_role_bindings`)).rows[0]).toEqual({
      granted_by: null,
    });
  });

  it('stores a revision with its author and keeps (agent, seq) unique', async () => {
    const r1 = randomUUID();
    await revision(r1, agent, root, 1);
    expect(await failure(revision(randomUUID(), agent, root, 1))).toMatch(
      /agent_draft_revisions_agent_seq_uq/,
    );
    await revision(randomUUID(), agent, root, 2, { authorKind: 'system', authorId: null });
    expect(
      await failure(revision(randomUUID(), agent, root, 3, { authorKind: 'user', authorId: null })),
    ).toMatch(/agent_draft_revisions_author_check/);
    expect(await failure(revision(randomUUID(), agent, root, 4, { authorKind: 'robot' }))).toMatch(
      /agent_draft_revisions_author_kind/,
    );
  });

  it('refuses a revision whose tenant differs from the tenant of its agent', async () => {
    expect(await failure(revision(randomUUID(), foreignAgent, root, 1))).toMatch(
      /revision tenant differs/,
    );
  });

  it('makes a revision immutable', async () => {
    const id = randomUUID();
    await revision(id, agent, root, 10);
    expect(
      await failure(
        c.query(`update agent_draft_revisions set source = 'changed' where id = $1`, [id]),
      ),
    ).toMatch(/append-only/);
  });

  it('keeps one open review per agent and refuses cross-agent and cross-tenant rows', async () => {
    const rev = randomUUID();
    await revision(rev, agent, root, 20);
    const rid = randomUUID();
    await review(rid, agent, root, rev);
    expect(await failure(review(randomUUID(), agent, root, rev))).toMatch(
      /agent_reviews_one_open_uq/,
    );
    // another agent's revision, another tenant
    const frev = randomUUID();
    await revision(frev, foreignAgent, other, 1);
    expect(await failure(review(randomUUID(), agent, root, frev))).toMatch(
      /review revision belongs to another agent/,
    );
    expect(await failure(review(randomUUID(), foreignAgent, root, frev))).toMatch(
      /review tenant differs/,
    );
    // a closed review frees the slot
    await c.query(
      `update agent_reviews set status = 'withdrawn', closed_at = now(), closed_by = $2 where id = $1`,
      [rid, user],
    );
    await review(randomUUID(), agent, root, rev);
  });

  it('freezes the binding fields of a review and every closed review', async () => {
    const rev = randomUUID();
    await revision(rev, foreignAgent, other, 2);
    const rid = randomUUID();
    await review(rid, foreignAgent, other, rev);
    for (const set of [
      `policy_digest = '${HEX('d')}'`,
      `required_approvals = 2`,
      `opened_by = '${randomUUID()}'`,
    ])
      expect(
        await failure(c.query(`update agent_reviews set ${set} where id = $1`, [rid])),
      ).toMatch(/binding fields of a review cannot change/);
    expect(
      await failure(
        c.query(`update agent_reviews set status = 'bogus', closed_at = now() where id = $1`, [
          rid,
        ]),
      ),
    ).toMatch(/agent_reviews_status_check/);
    expect(
      await failure(c.query(`update agent_reviews set status = 'rejected' where id = $1`, [rid])),
    ).toMatch(/agent_reviews_closed_check/);
    await c.query(`update agent_reviews set status = 'rejected', closed_at = now() where id = $1`, [
      rid,
    ]);
    expect(
      await failure(
        c.query(`update agent_reviews set status = 'open', closed_at = null where id = $1`, [rid]),
      ),
    ).toMatch(/a closed review cannot change/);
  });

  it('records decisions append-only and ties them to the review agent', async () => {
    const rev = randomUUID();
    await revision(rev, agent, root, 30);
    const rid = randomUUID();
    await c.query(
      `update agent_reviews set status = 'withdrawn', closed_at = now() where agent_id = $1 and status = 'open'`,
      [agent],
    );
    await review(rid, agent, root, rev);
    const d = randomUUID();
    await decision(d, rid, rev);
    expect(
      await failure(c.query(`update agent_review_decisions set comment = 'x' where id = $1`, [d])),
    ).toMatch(/append-only/);
    expect(await failure(c.query(`delete from agent_review_decisions where id = $1`, [d]))).toMatch(
      /append-only/,
    );
    // a request_changes without an expiry, an approval with one only
    await decision(randomUUID(), rid, rev, 'request_changes');
    expect(
      await failure(
        c.query(
          `insert into agent_review_decisions (id, review_id, revision_id, digest, expansion_digest, resolution_digest, policy_digest,
             reviewer_id, reviewer_auth, acting_tenant_id, binding_refs, decision)
           values ($1, $2, $3, $4, $4, $4, $4, $5, 'session', $6, '[]'::jsonb, 'approve')`,
          [randomUUID(), rid, rev, HEX('c'), user, root],
        ),
      ),
    ).toMatch(/agent_review_decisions_expiry_check/);
    // a revision of another agent
    const frev = randomUUID();
    await revision(frev, foreignAgent, other, 3);
    expect(await failure(decision(randomUUID(), rid, frev))).toMatch(
      /decision revision belongs to another agent/,
    );
  });

  it('refuses a malformed digest', async () => {
    expect(
      await failure(
        c.query(
          `insert into agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_kind)
           values ($1, $2, $3, 99, 'xyz', 's', 'system')`,
          [randomUUID(), agent, root],
        ),
      ),
    ).toMatch(/agent_draft_revisions_digest_check/);
  });

  it('is reverted by the down script', async () => {
    // later migrations first: 0038, 0037 and 0034 depend on the review tables
    await c.script(
      readFileSync(join(MIGRATIONS_FOLDER, 'down/0038_agent_publish_gate.down.sql'), 'utf8'),
    );
    await c.script(
      readFileSync(join(MIGRATIONS_FOLDER, 'down/0037_stored_grant_chain.down.sql'), 'utf8'),
    );
    await c.script(
      readFileSync(join(MIGRATIONS_FOLDER, 'down/0034_review_threads.down.sql'), 'utf8'),
    );
    await c.script(DOWN);
    const cols = async (t: string) =>
      (
        await c.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = $1`,
          [t],
        )
      ).rows.map((r) => r.column_name);
    expect(await cols('tenants')).not.toContain('settings');
    expect(await cols('agents')).not.toContain('draft_revision_id');
    expect(await cols('agent_versions')).not.toContain('revision_id');
    expect(await cols('team_members')).not.toContain('granted_by');
    expect(await cols('agent_role_bindings')).not.toContain('granted_by');
    expect(await cols('agent_reviews')).toEqual([]);
    expect(await cols('agent_draft_revisions')).toEqual([]);
    expect(await cols('agent_review_decisions')).toEqual([]);
    // the agents and their drafts are untouched
    expect(
      (await c.query(`select draft_source from agents where id = $1`, [agent])).rows[0],
    ).toEqual({ draft_source: 'x' });
  });
});
