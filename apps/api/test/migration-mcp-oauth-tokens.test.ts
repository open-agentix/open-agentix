import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0026 (ADR 0016 slice S5): additive tables for the key service and the encrypted MCP
 * OAuth token store. Existing connections are untouched, the checks hold whatever code writes a
 * row, tokens go with their connection and the down script removes the tables. PGlite and, with
 * OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0026_mcp_oauth_tokens';
const TABLES = ['mcp_oauth_clients', 'mcp_oauth_tokens', 'tenant_data_keys'];
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0026 files', () => {
  it('follows 0025 in the journal and has a snapshot chained to 0025 and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0025_approvals_consumed_at') + 1);
    expect(tags.filter((t) => t.startsWith('0026_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const [s25, s26] = [read('0025'), read('0026')];
    expect(s26.prevId).toBe(s25.id);
    expect(Object.keys(s26.tables)).toEqual(
      expect.arrayContaining(TABLES.map((t) => `public.${t}`)),
    );
    expect(Object.keys(s25.tables)).not.toContain('public.mcp_oauth_tokens');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0026 on existing data (%s)', (_kind, enabled, open) => {
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
        `select table_name from information_schema.tables
          where table_name in ('mcp_oauth_tokens', 'mcp_oauth_clients', 'tenant_data_keys')`,
      )
    ).rows
      .map((r) => r.table_name)
      .sort();
  const token = (over: Record<string, unknown> = {}) =>
    c.query(
      `insert into mcp_oauth_tokens (id, tenant_id, connection_id, credential_version, issuer, client_ref,
                                     resource, key_version, access_token_enc, status)
       values ($1, $2, $3, $4, 'https://auth.example.org', 'client', 'https://x.example/mcp', 1, 'oaxe1.a.b.c', $5)`,
      [
        randomUUID(),
        DEFAULT_TENANT_ID,
        over.connection ?? connection,
        over.version ?? 1,
        over.status ?? 'active',
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

  it('adds the three tables and leaves the existing connection without tokens', async () => {
    expect(await tables()).toEqual(TABLES);
    expect(
      (await c.query(`select id from connections where id = $1`, [connection])).rows,
    ).toHaveLength(1);
    expect((await c.query(`select id from mcp_oauth_tokens`)).rows).toHaveLength(0);
  });

  it('keeps one token row per connection and credential version and checks the status', async () => {
    await token();
    expect(await failure(token())).toMatch(/mcp_oauth_tokens_connection_version_uq/);
    await token({ version: 2, status: 'revoked' });
    expect(await failure(token({ version: 3, status: 'bogus' }))).toMatch(
      /mcp_oauth_tokens_status/,
    );
    expect(await failure(token({ connection: randomUUID(), version: 9 }))).toMatch(
      /mcp_oauth_tokens_connection_id_connections_id_fk/,
    );
  });

  it('allows one active data key per tenant and no key material for a destroyed one', async () => {
    const key = (version: number, status: string, wrapped: string | null) =>
      c.query(
        `insert into tenant_data_keys (tenant_id, version, wrapped_key, kek_id, status) values ($1, $2, $3, 'kek-1', $4)`,
        [DEFAULT_TENANT_ID, version, wrapped, status],
      );
    await key(1, 'active', 'oaxe1.a.b.c');
    expect(await failure(key(2, 'active', 'oaxe1.a.b.c'))).toMatch(/tenant_data_keys_active_uq/);
    await key(2, 'retired', 'oaxe1.a.b.c');
    expect(await failure(key(3, 'destroyed', 'oaxe1.a.b.c'))).toMatch(/tenant_data_keys_material/);
    expect(await failure(key(3, 'retired', null))).toMatch(/tenant_data_keys_material/);
    await key(3, 'destroyed', null);
  });

  it('keeps one registered client per tenant and issuer; a secret needs its key version', async () => {
    const client = (issuer: string, version: number | null, enc: string | null) =>
      c.query(
        `insert into mcp_oauth_clients (id, tenant_id, issuer, client_id, key_version, client_secret_enc)
         values ($1, $2, $3, 'cid', $4, $5)`,
        [randomUUID(), DEFAULT_TENANT_ID, issuer, version, enc],
      );
    await client('https://a.example', 1, 'oaxe1.a.b.c');
    expect(await failure(client('https://a.example', null, null))).toMatch(
      /mcp_oauth_clients_tenant_issuer_uq/,
    );
    expect(await failure(client('https://b.example', null, 'oaxe1.a.b.c'))).toMatch(
      /mcp_oauth_clients_secret/,
    );
  });

  it('removes tokens with their connection', async () => {
    await c.query(`delete from connections where id = $1`, [connection]);
    expect((await c.query(`select id from mcp_oauth_tokens`)).rows).toHaveLength(0);
  });

  it('the down script removes the tables and can run twice', async () => {
    await c.script(DOWN);
    expect(await tables()).toEqual([]);
    await c.script(DOWN);
  });
});
