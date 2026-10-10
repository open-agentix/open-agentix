import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0020 (ADR 0015 slice S2) on a database that already holds runs: additive, old runs keep
 * NULL, the shape checks, the immutability trigger and the down path. PGlite and, with
 * OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0020_run_trace_identity';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');
const A = 'a'.repeat(32);
const B = 'b'.repeat(16);

describe('migration 0020 files', () => {
  it('is the next free number after 0019 and has a snapshot chained to 0019', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0019_trb_home_move') + 1);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(existsSync(join(MIGRATIONS_FOLDER, 'meta/0020_snapshot.json'))).toBe(true);
    const [s19, s20] = [read('0019'), read('0020')];
    expect(s20.prevId).toBe(s19.id);
    const cols = (s: { tables: Record<string, { columns: Record<string, unknown> }> }, t: string) =>
      Object.keys(s.tables[t]!.columns);
    expect(cols(s20, 'public.runs')).toEqual(
      expect.arrayContaining(['trace_id', 'trace_root_span_id']),
    );
    expect(cols(s20, 'public.run_node_sessions')).toContain('trace_context');
    expect(cols(s19, 'public.runs')).not.toContain('trace_id');
  });
});

describe.each(sqlTargets)('migration 0020 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const agent = randomUUID();
  const version = randomUUID();
  const oldRun = randomUUID();
  const runCols = async () =>
    (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'runs'`,
      )
    ).rows.map((r) => r.column_name);
  const insertRun = (id: string, traceId: string | null, span: string | null) =>
    c.query(
      `insert into runs (id, tenant_id, agent_id, agent_version_id, status, triggered_by, trace_id, trace_root_span_id)
       values ($1, $2, $3, $4, 'queued', 'manual:u', $5, $6)`,
      [id, DEFAULT_TENANT_ID, agent, version, traceId, span],
    );

  beforeAll(async () => {
    c = await open();
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    await c.migrate(dir);
    expect(await runCols()).not.toContain('trace_id');
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'old', 'x')`,
      [agent, DEFAULT_TENANT_ID],
    );
    await c.query(
      `insert into agent_versions (id, agent_id, version, digest, source, definition)
       values ($1, $2, '1.0.0', 'd', 'x', '{}')`,
      [version, agent],
    );
    await c.query(
      `insert into runs (id, tenant_id, agent_id, agent_version_id, status, triggered_by)
       values ($1, $2, $3, $4, 'succeeded', 'manual:u')`,
      [oldRun, DEFAULT_TENANT_ID, agent, version],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds the columns and leaves existing runs without a trace', async () => {
    expect(await runCols()).toEqual(expect.arrayContaining(['trace_id', 'trace_root_span_id']));
    const { rows } = await c.query<{ trace_id: string | null; trace_root_span_id: string | null }>(
      `select trace_id, trace_root_span_id from runs where id = $1`,
      [oldRun],
    );
    expect(rows[0]).toEqual({ trace_id: null, trace_root_span_id: null });
    const sessions = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'run_node_sessions'`,
    );
    expect(sessions.rows.map((r) => r.column_name)).toContain('trace_context');
  });

  it('accepts a well-formed pair and refuses half-set, malformed and all-zero ids', async () => {
    await insertRun(randomUUID(), A, B);
    await insertRun(randomUUID(), null, null);
    for (const [t, s] of [
      [A, null],
      [null, B],
      ['0'.repeat(32), B],
      [A, '0'.repeat(16)],
      ['A'.repeat(32), B],
      ['a'.repeat(31), B],
      [A, 'b'.repeat(17)],
      [`${'a'.repeat(31)}\n`, B],
    ] as const)
      expect(await failure(insertRun(randomUUID(), t, s)), `${t} / ${s}`).toMatch(
        /runs_trace_ids_shape/,
      );
  });

  it('refuses any change of the ids once the row exists, and lets other updates through', async () => {
    const id = randomUUID();
    await insertRun(id, A, B);
    expect(
      await failure(c.query(`update runs set trace_id = $2 where id = $1`, [id, 'c'.repeat(32)])),
    ).toMatch(/immutable/);
    expect(
      await failure(
        c.query(`update runs set trace_id = null, trace_root_span_id = null where id = $1`, [id]),
      ),
    ).toMatch(/immutable/);
    // An old run cannot be given an identity afterwards either.
    expect(
      await failure(
        c.query(`update runs set trace_id = $2, trace_root_span_id = $3 where id = $1`, [
          oldRun,
          A,
          B,
        ]),
      ),
    ).toMatch(/immutable/);
    await c.query(`update runs set status = 'running', attempts = attempts + 1 where id = $1`, [
      id,
    ]);
    await c.query(`update runs set trace_id = trace_id where id = $1`, [id]);
    const { rows } = await c.query<{ trace_id: string }>(
      `select trace_id from runs where id = $1`,
      [id],
    );
    expect(rows[0]!.trace_id).toBe(A);
  });

  it('checks the shape of run_node_sessions.trace_context', async () => {
    const ok = `00-${A}-${B}-01`;
    const run = randomUUID();
    await insertRun(run, A, B);
    const insert = (v: string | null) =>
      c.query(
        `insert into run_node_sessions (id, run_id, tenant_id, node_id, orchestrator_id, steps, expires_at, trace_context)
         values ($1, $2, $3, $4, 'w', '[]', now() + interval '1 hour', $5)`,
        [randomUUID(), run, DEFAULT_TENANT_ID, `node-${randomUUID()}`, v],
      );
    await insert(ok);
    await insert(null);
    for (const bad of ['x', `01-${A}-${B}-01`, `00-${A}-${B}-02`, `00-${A.toUpperCase()}-${B}-01`])
      expect(await failure(insert(bad)), bad).toMatch(/run_node_sessions_trace_context_shape/);
  });

  it('the down script reverts it and can run twice', async () => {
    await c.script(DOWN);
    expect(await runCols()).not.toContain('trace_id');
    expect(await runCols()).not.toContain('trace_root_span_id');
    const sessions = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'run_node_sessions'`,
    );
    expect(sessions.rows.map((r) => r.column_name)).not.toContain('trace_context');
    const trg = await c.query(
      `select 1 from pg_trigger where tgname = 'runs_trace_identity_immutable_trg'`,
    );
    expect(trg.rows).toHaveLength(0);
    await c.script(DOWN);
    // Existing runs survived and the application of the migration again works.
    const { rows } = await c.query(`select id from runs where id = $1`, [oldRun]);
    expect(rows).toHaveLength(1);
  });
});
