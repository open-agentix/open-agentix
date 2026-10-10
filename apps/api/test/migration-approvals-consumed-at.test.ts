import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0025 (ADR 0016 slice S4): one nullable column that makes an approval single use for the
 * MCP relay. Approvals decided before the upgrade count as used, the single-use statement is atomic, the down script
 * reverts it. PGlite and, with OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0025_approvals_consumed_at';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0025 files', () => {
  it('follows 0024 in the journal and has a snapshot chained to 0024 and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0024_mcp_tool_snapshots') + 1);
    expect(tags.filter((t) => t.startsWith('0025_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const [s24, s25] = [read('0024'), read('0025')];
    expect(s25.prevId).toBe(s24.id);
    expect(Object.keys(s25.tables['public.approvals'].columns)).toEqual(
      expect.arrayContaining(['consumed_at', 'args_redacted']),
    );
    expect(Object.keys(s24.tables['public.approvals'].columns)).not.toContain('consumed_at');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0025 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const agent = randomUUID();
  const version = randomUUID();
  const run = randomUUID();
  const oldApproval = randomUUID();
  const pending = randomUUID();
  const cols = async () =>
    (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'approvals'`,
      )
    ).rows.map((r) => r.column_name);
  const approval = (id: string) =>
    c.query(
      `insert into approvals (id, tenant_id, run_id, agent_id, tool, args, reasons, approver_roles, status, expires_at)
       values ($1, $2, $3, 'a', 'jira/risky', '{"n":1}', '[]', '{admin}', 'approved', now() + interval '1 hour')`,
      [id, DEFAULT_TENANT_ID, run],
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
    expect(await cols()).not.toContain('consumed_at');
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
    await approval(oldApproval);
    await c.query(
      `insert into approvals (id, tenant_id, run_id, agent_id, tool, args, reasons, approver_roles, status, expires_at)
       values ($1, $2, $3, 'a', 'jira/risky', '{}', '[]', '{admin}', 'pending', now() + interval '1 hour')`,
      [pending, DEFAULT_TENANT_ID, run],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds the columns and marks every approval decided before the upgrade as used', async () => {
    expect(await cols()).toEqual(expect.arrayContaining(['consumed_at', 'args_redacted']));
    const { rows } = await c.query<{ consumed_at: unknown; args_redacted: boolean }>(
      `select consumed_at, args_redacted from approvals where id = $1`,
      [oldApproval],
    );
    expect(rows[0]!.consumed_at).not.toBeNull();
    expect(rows[0]!.args_redacted).toBe(false);
    // a pending approval is not used: it can still be decided and then used once
    const pendingRow = await c.query<{ consumed_at: unknown }>(
      `select consumed_at from approvals where id = $1`,
      [pending],
    );
    expect(pendingRow.rows[0]!.consumed_at).toBeNull();
  });

  it('the single-use statement of the relay consumes an approval exactly once', async () => {
    const id = randomUUID();
    await approval(id);
    const take = () =>
      c.query(
        `update approvals set consumed_at = now()
          where id = (select id from approvals where run_id = $1 and id = $2 and status = 'approved'
                        and consumed_at is null and args = $3::jsonb limit 1)
          returning id`,
        [run, id, '{"n":1}'],
      );
    expect((await take()).rows).toHaveLength(1);
    expect((await take()).rows).toHaveLength(0);
  });

  it('the down script reverts it and can run twice', async () => {
    await c.script(DOWN);
    expect(await cols()).not.toContain('consumed_at');
    expect(await cols()).not.toContain('args_redacted');
    await c.script(DOWN);
    const { rows } = await c.query(`select id from approvals where id = $1`, [oldApproval]);
    expect(rows).toHaveLength(1);
  });
});
