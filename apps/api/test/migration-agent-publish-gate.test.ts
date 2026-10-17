import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0038 (ADR 0017 slice S3): the approval record of a version, the version a review ended
 * in, and append-only version deprecations. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a
 * real PostgreSQL.
 */
const TAG = '0038_agent_publish_gate';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');
const HEX = (c: string) => c.repeat(64);

describe('migration 0038 files', () => {
  it('is strictly ordered and chains its snapshot', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(32);
    expect(journal.entries[at]!.idx).toBe(32);
    expect(journal.entries[at]!.when).toBe(1_792_700_000_007);
    expect(journal.entries[at - 1]!.tag).toBe('0037_stored_grant_chain');
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0038').prevId).toBe(read('0037').id);
    expect(Object.keys(read('0038').tables)).toContain('public.agent_version_deprecations');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0038 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const agent = randomUUID();
  const user = randomUUID();
  const revision = randomUUID();
  const review = randomUUID();
  const oldVersion = randomUUID();
  const newVersion = randomUUID();

  const version = (id: string, v: string, extra = '', params: unknown[] = []) =>
    c.query(
      `insert into agent_versions (id, agent_id, version, digest, source, definition ${extra ? ', ' + extra.split('|')[0] : ''})
       values ($1, $2, $3, $4, 's', '{}'::jsonb ${extra ? ', ' + extra.split('|')[1] : ''})`,
      [id, agent, v, HEX(v.slice(-1)), ...params],
    );

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
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'a', 'x')`,
      [agent, root],
    );
    await c.query(
      `insert into agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_id, author_kind)
       values ($1, $2, $3, 1, $4, 'src', $5, 'user')`,
      [revision, agent, root, HEX('a'), user],
    );
    await c.query(
      `insert into agent_reviews (id, agent_id, tenant_id, opened_by, opened_revision_id, policy_snapshot, policy_digest, required_approvals)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 1)`,
      [review, agent, root, user, revision, HEX('b')],
    );
    await version(oldVersion, '1.0.0'); // a version from before the migration
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an existing version without an approval record', async () => {
    const row = (await c.query(`select * from agent_versions where id = $1`, [oldVersion]))
      .rows[0]!;
    expect(row).toMatchObject({
      review_id: null,
      approved_by: null,
      policy_digest: null,
      secret_resolution: null,
    });
  });

  it('keeps a review and its approvers together, and at least one approver', async () => {
    expect(await failure(version(randomUUID(), '1.1.0', 'review_id|$5', [review]))).toMatch(
      /agent_versions_approval_check/,
    );
    expect(
      await failure(
        version(randomUUID(), '1.1.0', 'approved_by|$5::uuid[]', [`{${randomUUID()}}`]),
      ),
    ).toMatch(/agent_versions_approval_check/);
    expect(
      await failure(
        version(randomUUID(), '1.1.0', 'review_id, approved_by|$5, $6::uuid[]', [review, '{}']),
      ),
    ).toMatch(/agent_versions_approval_check/);
  });

  it('lets a review approve exactly one version, and a published review name it', async () => {
    await version(newVersion, '1.2.0', 'review_id, approved_by|$5, $6::uuid[]', [
      review,
      `{${user}}`,
    ]);
    expect(
      await failure(
        version(randomUUID(), '1.3.0', 'review_id, approved_by|$5, $6::uuid[]', [
          review,
          `{${user}}`,
        ]),
      ),
    ).toMatch(/agent_versions_review_uq/);
    // a published review must name its version, and only a published review may
    expect(
      await failure(
        c.query(`update agent_reviews set status = 'published', closed_at = now() where id = $1`, [
          review,
        ]),
      ),
    ).toMatch(/agent_reviews_published_check/);
    await c.query(
      `update agent_reviews set status = 'published', closed_at = now(), published_version_id = $2 where id = $1`,
      [review, newVersion],
    );
    expect(
      await failure(
        c.query(`update agent_reviews set published_version_id = $2 where id = $1`, [
          review,
          oldVersion,
        ]),
      ),
    ).toMatch(/closed review cannot change|published_check/);
  });

  it('keeps versions insert-only and deprecations append-only', async () => {
    expect(
      await failure(
        c.query(`update agent_versions set review_id = null where id = $1`, [newVersion]),
      ),
    ).toMatch(/append-only|immutable/i);
    await c.query(
      `insert into agent_version_deprecations (version_id, agent_id, deprecated_by, rollback_to_version_id)
       values ($1, $2, $3, $4)`,
      [newVersion, agent, user, oldVersion],
    );
    expect(await failure(c.query(`delete from agent_version_deprecations`))).toMatch(/append-only/);
    expect(await failure(c.query(`update agent_version_deprecations set reason = 'x'`))).toMatch(
      /append-only/,
    );
    expect(await failure(c.query(`truncate agent_version_deprecations`))).toMatch(/append-only/);
    // a version is deprecated once
    expect(
      await failure(
        c.query(
          `insert into agent_version_deprecations (version_id, agent_id, deprecated_by) values ($1, $2, $3)`,
          [newVersion, agent, user],
        ),
      ),
    ).toMatch(/duplicate key|pkey/);
    // the reason is bounded
    expect(
      await failure(
        c.query(
          `insert into agent_version_deprecations (version_id, agent_id, deprecated_by, reason) values ($1, $2, $3, $4)`,
          [oldVersion, agent, user, 'x'.repeat(501)],
        ),
      ),
    ).toMatch(/agent_version_deprecations_reason_len/);
  });

  it('is reverted by the down script, leaving reviews and versions alone', async () => {
    await c.script(DOWN);
    const cols = async (t: string) =>
      (
        await c.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = $1`,
          [t],
        )
      ).rows.map((r) => r.column_name);
    expect(await cols('agent_version_deprecations')).toEqual([]);
    expect(await cols('agent_versions')).not.toContain('review_id');
    expect(await cols('agent_versions')).not.toContain('secret_resolution');
    expect(await cols('agent_reviews')).not.toContain('published_version_id');
    expect(
      (await c.query(`select id from agent_versions where agent_id = $1`, [agent])).rows,
    ).toHaveLength(2);
    expect(
      (await c.query(`select status from agent_reviews where id = $1`, [review])).rows[0],
    ).toEqual({
      status: 'published',
    });
  });
});
