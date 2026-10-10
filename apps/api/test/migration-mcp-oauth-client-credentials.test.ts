import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0027 (ADR 0016 slice S6): additive columns on mcp_oauth_tokens for the grant, the
 * pinned authorization server endpoints and the last renewal error. Rows written before it get the
 * defaults, the check holds whatever code writes a row, and the down script removes the columns.
 * PGlite and, with OAX_TEST_DATABASE_URL, a real PostgreSQL.
 */
const TAG = '0027_mcp_oauth_client_credentials';
const COLUMNS = ['endpoints', 'grant_type', 'last_error'];
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0027 files', () => {
  it('follows 0026 in the journal and has a snapshot chained to 0026 and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0026_mcp_oauth_tokens') + 1);
    expect(tags.filter((t) => t.startsWith('0027_'))).toEqual([TAG]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const [s26, s27] = [read('0026'), read('0027')];
    expect(s27.prevId).toBe(s26.id);
    const cols = Object.keys(s27.tables['public.mcp_oauth_tokens'].columns);
    expect(cols).toEqual(expect.arrayContaining(COLUMNS));
    expect(Object.keys(s26.tables['public.mcp_oauth_tokens'].columns)).not.toContain('endpoints');
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0027 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const connection = randomUUID();
  const columns = async () =>
    (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'mcp_oauth_tokens' and column_name in ('endpoints','grant_type','last_error')`,
      )
    ).rows
      .map((r) => r.column_name)
      .sort();
  const token = (grant?: string) =>
    c.query(
      `insert into mcp_oauth_tokens (id, tenant_id, connection_id, credential_version, issuer, client_ref,
                                     resource, key_version, access_token_enc ${grant ? ', grant_type' : ''})
       values ($1, $2, $3, $4, 'https://auth.example.org', 'client', 'https://x.example/mcp', 1,
               'oaxe1.a.b.c' ${grant ? ", '" + grant + "'" : ''})`,
      [randomUUID(), DEFAULT_TENANT_ID, connection, Math.floor(Math.random() * 1e6)],
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
    expect(await columns()).toEqual([]);
    await c.query(
      `insert into connections (id, tenant_id, scope, name, kind, config)
       values ($1, $2, 'tenant', 'old', 'mcp', '{"transport":"streamable-http","url":"https://x.example/mcp"}')`,
      [connection, DEFAULT_TENANT_ID],
    );
    await token(); // a token stored by the previous build
    await c.migrate(MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await c.close();
  });

  it('adds the columns and gives the existing token the defaults', async () => {
    expect(await columns()).toEqual(COLUMNS);
    const { rows } = await c.query<{ grant_type: string; endpoints: unknown; last_error: unknown }>(
      `select grant_type, endpoints, last_error from mcp_oauth_tokens`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grant_type: 'client_credentials',
      endpoints: {},
      last_error: null,
    });
  });

  it('checks the grant whatever code writes the row', async () => {
    await token('authorization_code');
    expect(await failure(token('password'))).toMatch(/mcp_oauth_tokens_grant/);
  });

  it('the down script removes the columns, keeps the rows, and can run twice', async () => {
    const before = (await c.query(`select id from mcp_oauth_tokens`)).rows.length;
    await c.script(DOWN);
    expect(await columns()).toEqual([]);
    expect((await c.query(`select id from mcp_oauth_tokens`)).rows).toHaveLength(before);
    await c.script(DOWN);
  });
});
