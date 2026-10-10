import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0022 (ADR 0015 slice S4) on a database that already holds sessions: additive, old
 * sessions keep NULL, the shape check, the down path. PGlite and, with OAX_TEST_DATABASE_URL, a
 * real PostgreSQL.
 */
const TAG = '0022_run_node_otel_session';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0022 files', () => {
  it('is the next free number after 0021 and has a snapshot chained to 0021', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0021_authz_epoch') + 1);
    expect(tags.filter((t) => t.startsWith('0022_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(existsSync(join(MIGRATIONS_FOLDER, 'meta/0022_snapshot.json'))).toBe(true);
    const [s21, s22] = [read('0021'), read('0022')];
    expect(s22.prevId).toBe(s21.id);
    expect(Object.keys(s22.tables['public.run_node_sessions'].columns)).toContain('otel_session');
    expect(Object.keys(s21.tables['public.run_node_sessions'].columns)).not.toContain(
      'otel_session',
    );
  });
});

describe.each(sqlTargets)('migration 0022 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const agent = randomUUID();
  const version = randomUUID();
  const run = randomUUID();
  const oldSession = randomUUID();
  const cols = async () =>
    (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'run_node_sessions'`,
      )
    ).rows.map((r) => r.column_name);
  const insert = (id: string, state: string | null) =>
    c.query(
      `insert into run_node_sessions (id, run_id, tenant_id, node_id, orchestrator_id, steps, expires_at, otel_session)
       values ($1, $2, $3, $4, 'w', '[]', now() + interval '1 hour', $5::jsonb)`,
      [id, run, DEFAULT_TENANT_ID, `node-${randomUUID()}`, state],
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
    expect(await cols()).not.toContain('otel_session');
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
       values ($1, $2, $3, $4, 'running', 'manual:u')`,
      [run, DEFAULT_TENANT_ID, agent, version],
    );
    await c.query(
      `insert into run_node_sessions (id, run_id, tenant_id, node_id, orchestrator_id, steps, expires_at)
       values ($1, $2, $3, 'node-old', 'w', '[]', now() + interval '1 hour')`,
      [oldSession, run, DEFAULT_TENANT_ID],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds the column and leaves existing sessions without telemetry state', async () => {
    expect(await cols()).toContain('otel_session');
    const { rows } = await c.query<{ otel_session: unknown }>(
      `select otel_session from run_node_sessions where id = $1`,
      [oldSession],
    );
    expect(rows[0]!.otel_session).toBeNull();
  });

  it('accepts a bounded state and refuses a malformed or oversized one', async () => {
    await insert(randomUUID(), null);
    await insert(
      randomUUID(),
      JSON.stringify({ runner: 'container', harness: null, dropped: 0, events: [] }),
    );
    const events = (n: number) => JSON.stringify({ dropped: 0, events: Array(n).fill({ k: 'x' }) });
    await insert(randomUUID(), events(1000));
    for (const bad of [
      '[]',
      '"x"',
      '{}',
      '{"events": {}, "dropped": 0}',
      '{"events": [], "dropped": "0"}',
      '{"events": []}',
      events(1001),
    ])
      expect(await failure(insert(randomUUID(), bad)), bad.slice(0, 40)).toMatch(
        /run_node_sessions_otel_session_shape/,
      );
  });

  it('appends and counts the way the control node does, and the cap statement holds', async () => {
    const id = randomUUID();
    await insert(id, JSON.stringify({ runner: null, harness: null, dropped: 0, events: [] }));
    const append = (cap: number) =>
      c.query(
        `update run_node_sessions
            set otel_session = jsonb_set(otel_session, '{events}', (otel_session->'events') || '{"k":"output","t":1}'::jsonb)
          where id = $1 and jsonb_array_length(otel_session->'events') < $2
          returning id`,
        [id, cap],
      );
    expect((await append(2)).rows).toHaveLength(1);
    expect((await append(2)).rows).toHaveLength(1);
    expect((await append(2)).rows).toHaveLength(0);
    const { rows } = await c.query<{ n: number }>(
      `select jsonb_array_length(otel_session->'events') as n from run_node_sessions where id = $1`,
      [id],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('the down script reverts it and can run twice', async () => {
    await c.script(DOWN);
    expect(await cols()).not.toContain('otel_session');
    await c.script(DOWN);
    const { rows } = await c.query(`select id from run_node_sessions where id = $1`, [oldSession]);
    expect(rows).toHaveLength(1);
  });
});
