import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0024 (ADR 0016 slice S3): two additive tables for pinned MCP tool definitions. An
 * existing database keeps working without any snapshot, the checks hold whatever code writes a row,
 * rows go with their connection, and the down script removes both tables. PGlite and, with
 * OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0024_mcp_tool_snapshots';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0024 files', () => {
  it('follows 0023 in the journal and has a snapshot chained to 0023 and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0023_trb_source') + 1);
    expect(tags.filter((t) => t.startsWith('0024_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(existsSync(join(MIGRATIONS_FOLDER, 'meta/0024_snapshot.json'))).toBe(true);
    const [s23, s24] = [read('0023'), read('0024')];
    expect(s24.prevId).toBe(s23.id);
    expect(Object.keys(s24.tables)).toEqual(
      expect.arrayContaining(['public.mcp_tool_snapshots', 'public.mcp_tool_snapshot_acceptances']),
    );
    expect(Object.keys(s23.tables)).not.toContain('public.mcp_tool_snapshots');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

const HEX = 'a'.repeat(64);

describe.each(sqlTargets)('migration 0024 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const connection = randomUUID();
  const tables = async () =>
    (
      await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_name like 'mcp_tool_snapshot%'`,
      )
    ).rows
      .map((r) => r.table_name)
      .sort();
  const snapshot = (over: Partial<Record<string, string>> = {}) =>
    c.query(
      `insert into mcp_tool_snapshots (id, tenant_id, connection_id, digest, tools, tool_count, status, source, approval_scope)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [
        randomUUID(),
        DEFAULT_TENANT_ID,
        over.connection ?? connection,
        over.digest ?? HEX,
        over.tools ?? '[]',
        over.count ?? '0',
        over.status ?? 'pending',
        over.source ?? 'refresh',
        over.scope ?? null,
      ],
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
    expect(await tables()).toEqual([]);
    await c.query(
      `insert into connections (id, tenant_id, scope, name, kind, config)
       values ($1, $2, 'tenant', 'old', 'mcp', '{"transport":"streamable-http","url":"https://x.example/mcp"}')`,
      [connection, DEFAULT_TENANT_ID],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds both tables and leaves the existing connection without a snapshot', async () => {
    expect(await tables()).toEqual(['mcp_tool_snapshot_acceptances', 'mcp_tool_snapshots']);
    const { rows } = await c.query(`select id from connections where id = $1`, [connection]);
    expect(rows).toHaveLength(1);
    const none = await c.query(`select id from mcp_tool_snapshots where connection_id = $1`, [
      connection,
    ]);
    expect(none.rows).toHaveLength(0);
  });

  it('accepts a bounded snapshot and refuses malformed ones, whatever code writes them', async () => {
    await snapshot();
    await snapshot({
      digest: 'b'.repeat(64),
      tools: '[{"name":"a"}]',
      count: '1',
      status: 'approved',
      scope: 'new-versions',
    });
    for (const [label, bad, pattern] of [
      ['digest not hex', { digest: 'xyz' }, /mcp_tool_snapshots_digest/],
      ['uppercase digest', { digest: 'A'.repeat(64) }, /mcp_tool_snapshots_digest/],
      ['status', { digest: 'c'.repeat(64), status: 'maybe' }, /mcp_tool_snapshots_status/],
      ['source', { digest: 'd'.repeat(64), source: 'node' }, /mcp_tool_snapshots_source/],
      ['scope', { digest: 'e'.repeat(64), scope: 'everyone' }, /mcp_tool_snapshots_scope/],
      ['not an array', { digest: 'f'.repeat(64), tools: '{}' }, /mcp_tool_snapshots_tools/],
      [
        'count mismatch',
        { digest: '1'.repeat(64), tools: '[]', count: '3' },
        /mcp_tool_snapshots_tools/,
      ],
      [
        'too many tools',
        { digest: '2'.repeat(64), tools: JSON.stringify(Array(501).fill({})), count: '501' },
        /mcp_tool_snapshots_tools/,
      ],
    ] as const)
      expect(await failure(snapshot(bad)), label).toMatch(pattern);
  });

  it('keeps one row per connection and digest, and one acceptance per edge', async () => {
    expect(await failure(snapshot())).toMatch(/mcp_tool_snapshots_connection_digest_uq/);
    const accept = (from: string, to: string) =>
      c.query(
        `insert into mcp_tool_snapshot_acceptances (id, tenant_id, connection_id, from_digest, to_digest)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), DEFAULT_TENANT_ID, connection, from, to],
      );
    await accept(HEX, 'b'.repeat(64));
    expect(await failure(accept(HEX, 'b'.repeat(64)))).toMatch(/mcp_tool_snapshot_acceptances_uq/);
    expect(await failure(accept(HEX, HEX))).toMatch(/mcp_tool_snapshot_acceptances_digests/);
    expect(await failure(accept('nope', HEX))).toMatch(/mcp_tool_snapshot_acceptances_digests/);
  });

  it('requires a connection, and rows go with it', async () => {
    expect(await failure(snapshot({ connection: randomUUID(), digest: '3'.repeat(64) }))).toMatch(
      /foreign key|violates/i,
    );
    await c.query(`delete from connections where id = $1`, [connection]);
    for (const t of ['mcp_tool_snapshots', 'mcp_tool_snapshot_acceptances'])
      expect((await c.query(`select 1 from ${t}`)).rows).toHaveLength(0);
  });

  it('the down script removes both tables and can run twice', async () => {
    await c.script(DOWN);
    expect(await tables()).toEqual([]);
    await c.script(DOWN);
    expect((await c.query(`select id from tenants limit 1`)).rows.length).toBeGreaterThanOrEqual(0);
  });
});
