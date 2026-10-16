import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0033 (ADR 0014 slice S9, #194): the database bumps the authz epoch of the organisation
 * whenever `tenant_role_restrictions` changes. No schema change, so only the triggers and the down
 * path are checked here; the effect on cached principals is tested in role-restrictions.test.ts.
 * Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0033_role_restrictions_epoch';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0033 files', () => {
  it('is ordered in the journal and has a snapshot chained to the previous one and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    const at = tags.indexOf(TAG);
    expect(at).toBeGreaterThan(0);
    expect(tags[at - 1]! < TAG).toBe(true);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(tags).size).toBe(tags.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0033').prevId).toBe(read('0031').id);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0033 on a database (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const child = randomUUID();
  const other = randomUUID();
  const epoch = async (id: string) =>
    Number(
      (
        await c.query<{ e: string }>(`select authz_epoch::text as e from tenants where id = $1`, [
          id,
        ])
      ).rows[0]!.e,
    );
  const row = (tenant: string, permission = 'costs:read') =>
    c.query(
      `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, 'viewer', $2)`,
      [tenant, permission],
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    c = await open();
    await c.migrate(dir);
    await c.query(
      `insert into tenants (id, slug, name, parent_id, root_id, path, depth)
       values ($1, 'child', 'child', $2, $2, $3, 1)`,
      [child, root, `/${root}/${child}/`],
    );
    await c.query(
      `insert into tenants (id, slug, name, root_id, path, depth) values ($1, 'other', 'other', $1, $2, 0)`,
      [other, `/${other}/`],
    );
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bumps the epoch of the root of the restricted node on insert, update and delete', async () => {
    const e0 = await epoch(root);
    const o0 = await epoch(other);
    await row(child);
    const e1 = await epoch(root);
    expect(e1).toBeGreaterThan(e0);
    await c.query(
      `update tenant_role_restrictions set permission = 'runs:read' where tenant_id = $1`,
      [child],
    );
    const e2 = await epoch(root);
    expect(e2).toBeGreaterThan(e1);
    await c.query(`delete from tenant_role_restrictions where tenant_id = $1`, [child]);
    expect(await epoch(root)).toBeGreaterThan(e2);
    expect(await epoch(other)).toBe(o0);
  });

  it('still refuses admin and unknown roles at the table', async () => {
    await expect(
      c.query(
        `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, 'admin', 'users:write')`,
        [child],
      ),
    ).rejects.toThrow();
    await expect(
      c.query(
        `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, 'root', 'users:write')`,
        [child],
      ),
    ).rejects.toThrow();
  });

  it('is reverted by the down script, which keeps the rows and can run twice', async () => {
    await row(child);
    await c.script(DOWN);
    await c.script(DOWN);
    const trigs = (
      await c.query<{ tgname: string }>(
        `select tgname from pg_trigger where tgname like 'authz_epoch_trr_%'`,
      )
    ).rows;
    expect(trigs).toEqual([]);
    const e = await epoch(root);
    await c.query(`delete from tenant_role_restrictions where tenant_id = $1`, [child]);
    expect(await epoch(root)).toBe(e); // nothing bumps any more
    // the rest of the epoch machinery is untouched
    const fns = (
      await c.query<{ proname: string }>(
        `select proname from pg_proc where proname = 'authz_bump_trb_stmt'`,
      )
    ).rows;
    expect(fns).toHaveLength(1);
  });
});
