import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0034 (ADR 0017 slice S2): review comment threads and comments. Runs on PGlite and,
 * with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0034_review_threads';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');
const HEX = (c: string) => c.repeat(64);

describe('migration 0034 files', () => {
  it('is newer than the role restrictions migration, strictly ordered, and chains its snapshot', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at - 1]!.tag).toBe('0033_role_restrictions_epoch');
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(whens[at]!).toBeGreaterThan(1_792_700_000_002);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0034').prevId).toBe(read('0033').id);
    expect(Object.keys(read('0034').tables)).toEqual(
      expect.arrayContaining(['public.agent_review_threads', 'public.agent_review_comments']),
    );
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0034 on existing data (%s)', (_kind, enabled, open) => {
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
  const agent2 = randomUUID();
  const revision2 = randomUUID();
  const review2 = randomUUID();
  const other = randomUUID();

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
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'a2', 'x')`,
      [agent2, root],
    );
    await c.query(
      `insert into tenants (id, slug, name, root_id, path, depth) values ($1, 'other', 'other', $1, $2, 0)`,
      [other, `/${other}/`],
    );
    await c.query(
      `insert into agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_id, author_kind)
       values ($1, $2, $3, 1, $4, 'src', $5, 'user')`,
      [revision2, agent2, root, HEX('a'), user],
    );
    await c.query(
      `insert into agent_reviews (id, agent_id, tenant_id, opened_by, opened_revision_id, policy_snapshot, policy_digest, required_approvals)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 1)`,
      [review2, agent2, root, user, revision2, HEX('b')],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const thread = (
    id: string,
    kind: string,
    extra: {
      revisionId?: string | null;
      side?: string | null;
      line?: number | null;
      hash?: string | null;
    } = {},
  ) =>
    c.query(
      `insert into agent_review_threads (id, review_id, agent_id, tenant_id, created_by, anchor_kind, revision_id, side, line, line_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        review,
        agent,
        root,
        user,
        kind,
        extra.revisionId ?? null,
        extra.side ?? null,
        extra.line ?? null,
        extra.hash ?? null,
      ],
    );
  const comment = (id: string, threadId: string, body: string, deletedAt: string | null = null) =>
    c.query(
      `insert into agent_review_comments (id, thread_id, review_id, tenant_id, author_id, body, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, threadId, review, root, user, body, deletedAt],
    );

  it('keeps the earlier rows and stores a review thread and a line thread', async () => {
    expect((await c.query(`select id from agent_reviews where id = $1`, [review])).rows).toEqual([
      { id: review },
    ]);
    await thread(randomUUID(), 'review');
    await thread(randomUUID(), 'line', {
      revisionId: revision,
      side: 'head',
      line: 3,
      hash: HEX('c'),
    });
    await thread(randomUUID(), 'line', { side: 'base', line: 1, hash: HEX('d') });
  });

  it('refuses an anchor that does not fit its kind', async () => {
    const anchor = /agent_review_threads_anchor_check/;
    expect(await failure(thread(randomUUID(), 'review', { side: 'head' }))).toMatch(anchor);
    expect(await failure(thread(randomUUID(), 'line', { side: 'head', line: 1 }))).toMatch(anchor);
    expect(
      await failure(thread(randomUUID(), 'line', { side: 'middle', line: 1, hash: HEX('c') })),
    ).toMatch(anchor);
    expect(
      await failure(thread(randomUUID(), 'line', { side: 'head', line: 0, hash: HEX('c') })),
    ).toMatch(anchor);
    expect(
      await failure(thread(randomUUID(), 'line', { side: 'head', line: 1, hash: 'xyz' })),
    ).toMatch(anchor);
    expect(await failure(thread(randomUUID(), 'other'))).toMatch(
      /agent_review_threads_(kind|anchor)_check/,
    );
  });

  it('requires resolved_at and resolved_by together', async () => {
    const id = randomUUID();
    await thread(id, 'review');
    expect(
      await failure(
        c.query(`update agent_review_threads set resolved_at = now() where id = $1`, [id]),
      ),
    ).toMatch(/agent_review_threads_resolved_check/);
    await c.query(
      `update agent_review_threads set resolved_at = now(), resolved_by = $2 where id = $1`,
      [id, user],
    );
  });

  it('caps a comment at 10 000 characters and keeps a tombstone empty', async () => {
    const t = randomUUID();
    await thread(t, 'review');
    await comment(randomUUID(), t, 'a'.repeat(10_000));
    expect(await failure(comment(randomUUID(), t, 'a'.repeat(10_001)))).toMatch(
      /agent_review_comments_body_len/,
    );
    expect(await failure(comment(randomUUID(), t, ''))).toMatch(
      /agent_review_comments_deleted_check/,
    );
    await comment(randomUUID(), t, '', new Date().toISOString());
    expect(await failure(comment(randomUUID(), t, 'text', new Date().toISOString()))).toMatch(
      /agent_review_comments_deleted_check/,
    );
  });

  it('refuses a comment for a thread that does not exist', async () => {
    expect(await failure(comment(randomUUID(), randomUUID(), 'x'))).toMatch(
      /foreign key|violates/i,
    );
  });

  it('ties a thread to the agent and tenant of its review, and a comment to the review and tenant of its thread', async () => {
    const t = randomUUID();
    await thread(t, 'review');
    const bad = (sql: string, params: unknown[]) => failure(c.query(sql, params));
    const insertThread = `insert into agent_review_threads (id, review_id, agent_id, tenant_id, created_by, anchor_kind) values ($1, $2, $3, $4, $5, 'review')`;
    expect(await bad(insertThread, [randomUUID(), review, agent2, root, user])).toMatch(
      /agent_review_threads_review_fk/,
    );
    expect(await bad(insertThread, [randomUUID(), review, agent, other, user])).toMatch(
      /agent_review_threads_review_fk|foreign key/,
    );
    const insertComment = `insert into agent_review_comments (id, thread_id, review_id, tenant_id, author_id, body) values ($1, $2, $3, $4, $5, 'x')`;
    expect(await bad(insertComment, [randomUUID(), t, review2, root, user])).toMatch(
      /agent_review_comments_thread_fk/,
    );
    expect(await bad(insertComment, [randomUUID(), t, review, other, user])).toMatch(
      /agent_review_comments_thread_fk/,
    );
  });

  it('never deletes or truncates threads and comments, and indexes the comments of a review', async () => {
    const t = randomUUID();
    await thread(t, 'review');
    await comment(randomUUID(), t, 'kept');
    expect(await failure(c.query(`delete from agent_review_comments`))).toMatch(/append-only/);
    expect(await failure(c.query(`delete from agent_review_threads`))).toMatch(/append-only/);
    expect(await failure(c.query(`truncate agent_review_comments`))).toMatch(/append-only/);
    expect(await failure(c.query(`truncate agent_review_threads cascade`))).toMatch(/append-only/);
    const idx = await c.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'agent_review_comments'`,
    );
    expect(idx.rows.map((r) => r.indexname)).toContain('agent_review_comments_review_idx');
  });

  it('is reverted by the down script, leaving the reviews alone', async () => {
    await c.script(DOWN);
    const tables = (
      await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_name like 'agent_review%'`,
      )
    ).rows.map((r) => r.table_name);
    expect(tables.sort()).toEqual(['agent_review_decisions', 'agent_reviews']);
    expect((await c.query(`select id from agent_reviews where id = $1`, [review])).rows).toEqual([
      { id: review },
    ]);
  });
});
