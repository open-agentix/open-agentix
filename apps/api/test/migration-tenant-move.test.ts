import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0034 (ADR 0014 slice S10, #195): the tree guard accepts a placement change only for a
 * node that has a parent before and after, inside one organisation, in a transaction that declared
 * the move, and a deferred trigger verifies the final placement of every changed row at commit.
 * Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0034_tenant_move';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0034 files', () => {
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
    expect(read('0034').prevId).toBe(read('0033').id);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0034 on a database (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const [r1, a, b, a1, r2] = Array.from({ length: 5 }, () => randomUUID());
  const insert = (id: string, slug: string, parent: string | null, root: string, path: string) =>
    c.query(
      `insert into tenants (id, slug, name, parent_id, root_id, path, depth) values ($1, $2, $2, $3, $4, $5, $6)`,
      [id, slug, parent, root, path, path.split('/').length - 3],
    );
  const placement = async (id: string) =>
    (
      await c.query<{ parent_id: string | null; path: string; depth: number }>(
        `select parent_id, path, depth from tenants where id = $1`,
        [id],
      )
    ).rows[0]!;
  /** A transaction that declares a move of the organisation `root`, then runs `body`. */
  const move = (root: string | null, body: string) =>
    c.script(
      `begin;${root ? `select set_config('oax.tenant_move_root', '${root}', true);` : ''}${body}commit;`,
    );
  const resetTree = async () => {
    await move(
      r1!,
      `update tenants set parent_id = '${r1}', path = '/${r1}/${a}/', depth = 1 where id = '${a}';
       update tenants set parent_id = '${r1}', path = '/${r1}/${b}/', depth = 1 where id = '${b}';
       update tenants set parent_id = '${a}', path = '/${r1}/${a}/${a1}/', depth = 2 where id = '${a1}';`,
    );
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    c = await open();
    await c.migrate(dir);
    await insert(r1!, 'mv-root', null, r1!, `/${r1}/`);
    await insert(a!, 'mv-a', r1!, r1!, `/${r1}/${a}/`);
    await insert(b!, 'mv-b', r1!, r1!, `/${r1}/${b}/`);
    await insert(a1!, 'mv-a1', a!, r1!, `/${r1}/${a}/${a1}/`);
    await insert(r2!, 'mv-root2', null, r2!, `/${r2}/`);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves a subtree in one declared transaction and bumps the epoch of its organisation', async () => {
    const e = async (id: string) =>
      Number(
        (
          await c.query<{ e: string }>(`select authz_epoch::text as e from tenants where id = $1`, [
            id,
          ])
        ).rows[0]!.e,
      );
    const [before, other] = [await e(r1!), await e(r2!)];
    // a under b: a and a1 change in one statement, as the application does it
    await move(
      r1!,
      `update tenants set
         path = '/${r1}/${b}/' || substr(path, ${`/${r1}/`.length + 1}),
         depth = depth + 1,
         parent_id = case when id = '${a}' then '${b}'::uuid else parent_id end
       where path like '/${r1}/${a}/%';`,
    );
    expect(await placement(a!)).toMatchObject({
      parent_id: b,
      path: `/${r1}/${b}/${a}/`,
      depth: 2,
    });
    expect(await placement(a1!)).toMatchObject({
      parent_id: a,
      path: `/${r1}/${b}/${a}/${a1}/`,
      depth: 3,
    });
    expect(await e(r1!)).toBeGreaterThan(before);
    expect(await e(r2!)).toBe(other);
    await resetTree();
    expect(await placement(a1!)).toMatchObject({ path: `/${r1}/${a}/${a1}/`, depth: 2 });
  });

  it('refuses a placement change that was not declared, or declared for another organisation', async () => {
    const sql = `update tenants set parent_id = '${b}', path = '/${r1}/${b}/${a}/', depth = 2 where id = '${a}';`;
    expect(await failure(move(null, sql))).toMatch(/immutable/);
    expect(await failure(move(r2!, sql))).toMatch(/immutable/);
    expect(await placement(a!)).toMatchObject({ parent_id: r1, path: `/${r1}/${a}/` });
  });

  it('refuses to move a root, to change the organisation, or to make a node a root', async () => {
    expect(
      await failure(
        move(
          r2!,
          `update tenants set parent_id = '${a}', path = '/${r1}/${a}/${r2}/', root_id = '${r1}', depth = 2 where id = '${r2}';`,
        ),
      ),
    ).toMatch(/immutable/);
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = '${a}', path = '/${r1}/${a}/${r1}/', depth = 2 where id = '${r1}';`,
        ),
      ),
    ).toMatch(/immutable|check/);
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = null, path = '/${a}/', root_id = '${a}', depth = 0 where id = '${a}';`,
        ),
      ),
    ).toMatch(/immutable/);
    expect(await placement(a!)).toMatchObject({ parent_id: r1 });
  });

  it('verifies the final placement at commit: a half-moved subtree and a wrong depth are rolled back', async () => {
    // the node moved but its child still has the old path
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = '${b}', path = '/${r1}/${b}/${a}/' , depth = 2 where id = '${a}';`,
        ),
      ),
    ).toMatch(/placement|check/);
    // consistent paths, but the parent id does not match the path
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = '${r1}', path = '/${r1}/${b}/${a}/', depth = 2 where id = '${a}';
                   update tenants set path = '/${r1}/${b}/${a}/${a1}/', depth = 3 where id = '${a1}';`,
        ),
      ),
    ).toMatch(/placement|check/);
    // a cycle: a under its own child
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = '${a1}', path = '/${r1}/${a}/${a1}/${a}/', depth = 3 where id = '${a}';`,
        ),
      ),
    ).toMatch(/placement|check|ancestor/);
    expect(await placement(a!)).toMatchObject({ parent_id: r1, path: `/${r1}/${a}/`, depth: 1 });
    expect(await placement(a1!)).toMatchObject({ parent_id: a });
  });

  it('still accepts every other update of a tenant without a declaration', async () => {
    await c.query(`update tenants set name = 'renamed' where id = $1`, [a]);
    await c.query(`update tenants set name = 'a' where id = $1`, [a]);
  });

  it('is reverted by the down script, which can run twice and freezes the placement again', async () => {
    await c.script(DOWN);
    await c.script(DOWN);
    const verify = (
      await c.query<{ tgname: string }>(
        `select tgname from pg_trigger where tgname = 'tenants_tree_verify_trg'`,
      )
    ).rows;
    expect(verify).toEqual([]);
    expect(
      await failure(
        move(
          r1!,
          `update tenants set parent_id = '${b}', path = '/${r1}/${b}/${a}/', depth = 2 where id = '${a}';`,
        ),
      ),
    ).toMatch(/immutable/);
  });
});
