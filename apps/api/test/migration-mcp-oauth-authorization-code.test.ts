import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0029 (ADR 0016 slice S7): the pending authorization requests table and the step-up scopes
 * and redirect URI columns. Rows written before it get the defaults, the checks hold whatever code
 * writes a row, and the down script removes everything it added and can run twice.
 * PGlite and, with OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0029_mcp_oauth_authorization_code';
const COLUMNS = ['required_scopes'];
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0029 files', () => {
  it('follows 0028 in the journal and has a snapshot chained to 0028 and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0028_pentest_role') + 1);
    expect(tags.filter((t) => t.startsWith('0029_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const [s27, s28] = [read('0028'), read('0029')];
    expect(s28.prevId).toBe(s27.id);
    const cols = Object.keys(s28.tables['public.mcp_oauth_tokens'].columns);
    expect(cols).toEqual(expect.arrayContaining(COLUMNS));
    expect(Object.keys(s27.tables['public.mcp_oauth_tokens'].columns)).not.toContain(
      'required_scopes',
    );
    expect(Object.keys(s27.tables)).not.toContain('public.mcp_oauth_pending');
    expect(Object.keys(s28.tables)).toContain('public.mcp_oauth_pending');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0029 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const connection = randomUUID();
  const has = async (table: string, column: string) =>
    (
      await c.query(
        `select 1 from information_schema.columns where table_name = $1 and column_name = $2`,
        [table, column],
      )
    ).rows.length > 0;
  const tableExists = async () =>
    (
      await c.query(
        `select 1 from information_schema.tables where table_name = 'mcp_oauth_pending'`,
      )
    ).rows.length > 0;
  const pending = (state: string, registration = 'preregistered') =>
    c.query(
      `insert into mcp_oauth_pending (id, state_hash, tenant_id, connection_id, credential_version, user_id,
                                      issuer, resource, redirect_uri, client_ref, registration, key_version,
                                      verifier_enc, endpoints, iss_advertised, expires_at)
       values ($1, $2, $3, $4, 1, $5, 'https://auth.example.org', 'https://x.example/mcp',
               'https://oax.example/v1/oauth/mcp/callback', 'client', $6, 1, 'oaxe1.a.b.c', '{}', false, now())`,
      [randomUUID(), state, DEFAULT_TENANT_ID, connection, randomUUID(), registration],
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
    expect(await tableExists()).toBe(false);
    await c.query(
      `insert into connections (id, tenant_id, scope, name, kind, config)
       values ($1, $2, 'tenant', 'old', 'mcp', '{"transport":"streamable-http","url":"https://x.example/mcp"}')`,
      [connection, DEFAULT_TENANT_ID],
    );
    await c.query(
      `insert into mcp_oauth_tokens (id, tenant_id, connection_id, credential_version, issuer, client_ref,
                                     resource, key_version, access_token_enc)
       values ($1, $2, $3, 1, 'https://auth.example.org', 'client', 'https://x.example/mcp', 1, 'oaxe1.a.b.c')`,
      [randomUUID(), DEFAULT_TENANT_ID, connection],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds the table and the columns and gives the existing token the defaults', async () => {
    expect(await tableExists()).toBe(true);
    expect(await has('mcp_oauth_clients', 'redirect_uri')).toBe(true);
    const { rows } = await c.query<{ required_scopes: string }>(
      `select required_scopes from mcp_oauth_tokens`,
    );
    expect(rows).toEqual([{ required_scopes: '' }]);
  });

  it('keeps a state once and checks the registration whatever code writes the row', async () => {
    await pending('hash-1');
    expect(await failure(pending('hash-1'))).toMatch(/mcp_oauth_pending_state_uq/);
    expect(await failure(pending('hash-2', 'password'))).toMatch(/mcp_oauth_pending_registration/);
  });

  it('removes the pending requests with the connection', async () => {
    await c.query(`delete from connections where id = $1`, [connection]);
    expect((await c.query(`select 1 from mcp_oauth_pending`)).rows).toHaveLength(0);
  });

  it('the down script removes what 0029 added, and can run twice', async () => {
    await c.script(DOWN);
    expect(await tableExists()).toBe(false);
    expect(await has('mcp_oauth_tokens', 'required_scopes')).toBe(false);
    expect(await has('mcp_oauth_clients', 'redirect_uri')).toBe(false);
    await c.script(DOWN);
  });
});
