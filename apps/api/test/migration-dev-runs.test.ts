import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0041 (ADR 0017 slice S5): development runs. On a database that already holds runs: old
 * runs become production runs, the shape check ties version, revision and starter together, the
 * stage cannot change, and the down script removes the development runs. PGlite and, with
 * OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0041_dev_runs';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0041 files', () => {
  it('is strictly ordered, has a snapshot chained to the previous one and a down script', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at]!.idx).toBe(35);
    expect(journal.entries[at]!.when).toBe(1_792_700_000_010);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(journal.entries[at - 1]!.tag).toBe('0040_secrets_store');
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0041').prevId).toBe(read('0040').id);
    const cols = (s: { tables: Record<string, { columns: Record<string, unknown> }> }, t: string) =>
      Object.keys(s.tables[t]!.columns);
    expect(cols(read('0041'), 'public.runs')).toEqual(
      expect.arrayContaining(['agent_revision_id', 'stage', 'started_by']),
    );
    expect(cols(read('0041'), 'public.cost_ledger')).toContain('stage');
    expect(Object.keys(read('0041').tables)).toContain('public.dev_run_definitions');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0041 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const agent = randomUUID();
  const version = randomUUID();
  const revision = randomUUID();
  const user = randomUUID();
  const oldRun = randomUUID();
  const oldLine = randomUUID();

  const insertRun = (over: Record<string, string | null> = {}, id: string = randomUUID()) => {
    const row: Record<string, string | null> = {
      tenant_id: DEFAULT_TENANT_ID,
      agent_id: agent,
      status: 'queued',
      triggered_by: 'manual:u',
      agent_version_id: version,
      ...over,
    };
    const cols = Object.keys(row);
    return c.query(
      `insert into runs (id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
      [id, ...cols.map((k) => row[k])],
    );
  };
  const dev = {
    stage: 'development',
    agent_version_id: null,
    agent_revision_id: revision,
    started_by: user,
  };

  beforeAll(async () => {
    c = await open();
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    await c.migrate(dir);
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
      `insert into agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_kind)
       values ($1, $2, $3, 1, $4, 'x', 'system')`,
      [revision, agent, DEFAULT_TENANT_ID, 'e'.repeat(64)],
    );
    await c.query(
      `insert into users (id, email, display_name, source, tenant_id) values ($1, 'u@dv.example.org', 'u', 'local', $2)`,
      [user, DEFAULT_TENANT_ID],
    );
    await c.query(
      `insert into runs (id, tenant_id, agent_id, agent_version_id, status, triggered_by)
       values ($1, $2, $3, $4, 'succeeded', 'manual:u')`,
      [oldRun, DEFAULT_TENANT_ID, agent, version],
    );
    await c.query(
      `insert into cost_ledger (run_id, tenant_id, agent_id, month, cost_micros) values ($1, $2, $3, '2026-10-01', 5)`,
      [oldLine, DEFAULT_TENANT_ID, agent],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('turns existing runs and cost lines into production ones', async () => {
    const run = await c.query<Record<string, unknown>>(
      `select stage, agent_revision_id, started_by, agent_version_id from runs where id = $1`,
      [oldRun],
    );
    expect(run.rows[0]).toEqual({
      stage: 'production',
      agent_revision_id: null,
      started_by: null,
      agent_version_id: version,
    });
    const line = await c.query<{ stage: string }>(
      `select stage from cost_ledger where run_id = $1`,
      [oldLine],
    );
    expect(line.rows[0]!.stage).toBe('production');
  });

  it('accepts a production run with a version and a development run with a revision and a starter', async () => {
    await insertRun();
    await insertRun(dev);
  });

  it('refuses every other combination of stage, version, revision and starter', async () => {
    const bad = (over: Record<string, string | null>) => failure(insertRun(over));
    // production without a version, or with a revision or a starter
    expect(await bad({ agent_version_id: null })).toMatch(/runs_stage_shape/);
    expect(await bad({ agent_revision_id: revision })).toMatch(/runs_stage_shape/);
    // development with a version, without a revision or without a starter
    expect(await bad({ ...dev, agent_version_id: version })).toMatch(/runs_stage_shape/);
    expect(await bad({ ...dev, agent_revision_id: null })).toMatch(/runs_stage_shape/);
    expect(await bad({ ...dev, started_by: null })).toMatch(/runs_stage_shape/);
    expect(await bad({ ...dev, stage: 'staging' })).toMatch(/runs_stage_shape/);
    // a revision that does not exist, a starter that does not exist
    expect(await bad({ ...dev, agent_revision_id: randomUUID() })).toMatch(
      /runs_agent_revision_id/,
    );
    expect(await bad({ ...dev, started_by: randomUUID() })).toMatch(/runs_started_by/);
  });

  it('never lets the stage, the version, the revision or the starter of a run change', async () => {
    const prod = randomUUID();
    const devId = randomUUID();
    await insertRun({}, prod);
    await insertRun(dev, devId);
    const update = (id: string, set: string, ...p: unknown[]) =>
      failure(c.query(`update runs set ${set} where id = $1`, [id, ...p]));
    expect(
      await update(
        devId,
        `stage = 'production', agent_version_id = $2, agent_revision_id = null, started_by = null`,
        version,
      ),
    ).toMatch(/immutable/);
    expect(
      await update(
        prod,
        `stage = 'development', agent_version_id = null, agent_revision_id = $2, started_by = $3`,
        revision,
        user,
      ),
    ).toMatch(/immutable/);
    expect(await update(devId, `started_by = $2`, randomUUID())).toMatch(
      /immutable|runs_started_by/,
    );
    // other updates, and updates that write the same values, go through
    await c.query(`update runs set status = 'running', attempts = attempts + 1 where id = $1`, [
      devId,
    ]);
    await c.query(`update runs set stage = stage, started_by = started_by where id = $1`, [devId]);
  });

  it('keeps the stage of a cost line to the two known values', async () => {
    const line = (stage: string) =>
      c.query(
        `insert into cost_ledger (run_id, tenant_id, agent_id, month, stage) values ($1, $2, $3, '2026-10-01', $4)`,
        [randomUUID(), DEFAULT_TENANT_ID, agent, stage],
      );
    await line('development');
    expect(await failure(line('staging'))).toMatch(/cost_ledger_stage_check/);
  });

  it('is reverted by the down script, which removes development runs and keeps production runs', async () => {
    const devId = randomUUID();
    await insertRun(dev, devId);
    await c.query(`insert into dev_run_definitions (run_id, definition) values ($1, '{}')`, [
      devId,
    ]);
    await c.query(
      `insert into cost_ledger (run_id, tenant_id, agent_id, month, stage) values ($1, $2, $3, '2026-10-01', 'development')`,
      [devId, DEFAULT_TENANT_ID, agent],
    );
    await c.script(DOWN);
    const cols = (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'runs'`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).not.toEqual(expect.arrayContaining(['stage']));
    expect(cols).not.toContain('started_by');
    expect(cols).not.toContain('agent_revision_id');
    expect((await c.query(`select 1 from runs where id = $1`, [devId])).rows).toHaveLength(0);
    expect((await c.query(`select 1 from runs where id = $1`, [oldRun])).rows).toHaveLength(1);
    expect(
      (
        await c.query(
          `select 1 from information_schema.tables where table_name = 'dev_run_definitions'`,
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await c.query(`select 1 from pg_proc where proname = 'oax_run_stage_immutable'`)).rows,
    ).toHaveLength(0);
    const notNull = await c.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns where table_name = 'runs' and column_name = 'agent_version_id'`,
    );
    expect(notNull.rows[0]!.is_nullable).toBe('NO');
  });
});
