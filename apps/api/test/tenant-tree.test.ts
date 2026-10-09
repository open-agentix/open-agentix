import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Principal } from '@openagentix/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

const UP = readFileSync(join(MIGRATIONS_FOLDER, '0013_tenant_hierarchy.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, 'down/0013_tenant_hierarchy.down.sql'), 'utf8');

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => String((e as { cause?: Error }).cause?.message ?? (e as Error).message),
  );

/** Minimal adapter so that the same checks run on PGlite and on a real PostgreSQL. */
interface Sql {
  query<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(q: string): Promise<unknown>;
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
}

const PG_URL = process.env.OAX_TEST_DATABASE_URL;

async function openPglite(): Promise<Sql> {
  const c = new PGlite();
  return {
    query: (q, params) => c.query(q, params) as never,
    exec: (q) => c.exec(q),
    migrate: (folder) => migrate(drizzle(c) as never, { migrationsFolder: folder }),
    close: () => c.close(),
  };
}

/** A throwaway database on the server of OAX_TEST_DATABASE_URL, dropped on close. */
async function openPostgres(): Promise<Sql> {
  const name = `w13_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return {
    query: (q, params) => pool.query(q, params) as never,
    exec: (q) => pool.query(q),
    migrate: (folder) => migratePg(drizzlePg(pool) as never, { migrationsFolder: folder }),
    close: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

const targets: [string, () => boolean, () => Promise<Sql>][] = [
  ['PGlite', () => true, openPglite],
  ['PostgreSQL', () => !!PG_URL, openPostgres],
];

describe.each(targets)('migration 0013 on existing flat data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let client: Sql;
  const A = randomUUID();
  const B = randomUUID();

  beforeAll(async () => {
    // A copy of the migrations without 0013 = the database as it is before the upgrade.
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0013'));
    writeFileSync(journalPath, JSON.stringify(journal));
    client = await open();
    await client.migrate(dir);
    await client.query(
      `insert into tenants (id, slug, name, monthly_budget_micros, secret_refs) values
       ($1, 'acme', 'Acme', 5000000, '["acme.*"]'), ($2, 'beta', 'Beta', null, '[]')`,
      [A, B],
    );
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tenants = async () =>
    (await client.query<Record<string, unknown>>('select * from tenants order by slug')).rows;

  it('turns every existing tenant into a root and keeps the other data', async () => {
    const before = await tenants();
    expect(before).toHaveLength(3);
    await client.migrate(MIGRATIONS_FOLDER);
    const after = await tenants();
    expect(after).toHaveLength(3);
    for (const t of after) {
      expect(t).toMatchObject({ parent_id: null, root_id: t.id, depth: 0, path: `/${t.id}/` });
    }
    const acme = after.find((t) => t.slug === 'acme')!;
    expect(acme).toMatchObject({ name: 'Acme', secret_refs: ['acme.*'] });
    expect(Number(acme.monthly_budget_micros)).toBe(5_000_000);
    expect(after.find((t) => t.id === DEFAULT_TENANT_ID)!.slug).toBe('default');
  });

  it('is idempotent: running the statements again changes nothing', async () => {
    const before = await tenants();
    for (const stmt of UP) await client.query(stmt);
    for (const stmt of UP) await client.query(stmt);
    expect(await tenants()).toEqual(before);
  });

  it('keeps root slugs globally unique but allows a slug under different parents', async () => {
    const dupId = randomUUID();
    expect(
      await failure(
        client.query(
          `insert into tenants (id, slug, name, root_id, path) values ($1, 'acme', 'x', $1, $2)`,
          [dupId, `/${dupId}/`],
        ),
      ),
    ).toMatch(/unique|duplicate/);
    const place = async (id: string, parent: string, slug: string) => {
      const p = (
        await client.query<{ path: string; depth: number; root_id: string }>(
          'select path, depth, root_id from tenants where id = $1',
          [parent],
        )
      ).rows[0]!;
      return client.query(
        `insert into tenants (id, slug, name, parent_id, root_id, path, depth) values ($1, $2, $2, $3, $4, $5, $6)`,
        [id, slug, parent, p.root_id, `${p.path}${id}/`, p.depth + 1],
      );
    };
    const c1 = randomUUID();
    await place(c1, A, 'sales');
    expect(await failure(place(randomUUID(), A, 'sales'))).toMatch(/unique|duplicate/);
    await place(randomUUID(), B, 'sales'); // same slug below another parent is fine at database level
    await place(randomUUID(), c1, 'sales');
    const sub = (
      await client.query('select id from tenants where path like $1 order by depth', [`/${A}/%`])
    ).rows;
    expect(sub).toHaveLength(3); // A, sales, sales/sales; not B's subtree
  });

  it('rejects inconsistent placements (path, depth, root, cycle, parent)', async () => {
    const ins = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return failure(
        client.query(
          `insert into tenants (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
          Object.values(cols),
        ),
      );
    };
    const id = randomUUID();
    const path = `${`/${A}/`}${id}/`;
    const ok = { id, slug: 'x1', name: 'x', parent_id: A, root_id: A, path, depth: 1 };
    expect(await ins({ ...ok, path: `/${A}/${randomUUID()}/` })).toMatch(/check|placement/);
    expect(await ins({ ...ok, depth: 2 })).toMatch(/check|placement/);
    expect(await ins({ ...ok, root_id: B })).toMatch(/check|placement/);
    expect(await ins({ ...ok, parent_id: randomUUID() })).toMatch(/does not exist|foreign key/);
    expect(await ins({ ...ok, parent_id: id })).toMatch(/does not exist|check|foreign key/);
    // depth beyond the technical maximum
    expect(await ins({ ...ok, depth: 33 })).toMatch(/check|placement/);
    let parent = { id: B, path: `/${B}/` };
    for (let d = 1; d <= 32; d++) {
      const nid = randomUUID();
      await ins({
        id: nid,
        slug: `deep${d}`,
        name: 'd',
        parent_id: parent.id,
        root_id: B,
        path: `${parent.path}${nid}/`,
        depth: d,
      }).then((r) => expect(r).toBe('no error'));
      parent = { id: nid, path: `${parent.path}${nid}/` };
    }
    const tooDeep = randomUUID();
    expect(
      await ins({
        id: tooDeep,
        slug: 'deep33',
        name: 'd',
        parent_id: parent.id,
        root_id: B,
        path: `${parent.path}${tooDeep}/`,
        depth: 33,
      }),
    ).toMatch(/tenants_tree_check|check/);
    // a root must be its own root
    const r = randomUUID();
    expect(await ins({ id: r, slug: 'x2', name: 'x', root_id: A, path: `/${A}/` })).toMatch(
      /check/,
    );
  });

  it('freezes the placement, restricts parent deletion and refuses the down path with children', async () => {
    const child = (
      await client.query<{ id: string; parent_id: string }>(
        'select id, parent_id from tenants where parent_id is not null limit 1',
      )
    ).rows[0]!;
    expect(
      await failure(client.query('update tenants set parent_id = $1 where id = $2', [B, child.id])),
    ).toMatch(/immutable/);
    expect(
      await failure(client.query('update tenants set path = $1 where id = $2', ['/x/', child.id])),
    ).toBeTruthy();
    await client.query("update tenants set name = 'renamed' where id = $1", [child.id]);
    expect(
      await failure(client.query('delete from tenants where id = $1', [child.parent_id])),
    ).toMatch(/foreign key|tenants_parent_id_fk/);
    expect(await failure(client.exec(DOWN))).toMatch(/nested tenants exist/);
  });

  it('can be reverted without nested tenants and re-applied', async () => {
    for (let d = 32; d >= 1; d--) await client.query('delete from tenants where depth = $1', [d]);
    await client.exec(DOWN);
    const cols = (
      await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'tenants'`,
      )
    ).rows.map((c) => c.column_name);
    expect(cols).not.toContain('path');
    expect(cols).not.toContain('parent_id');
    expect((await tenants()).map((t) => t.slug)).toEqual(['acme', 'beta', 'default']);
    expect(
      await failure(
        client.query(`insert into tenants (id, slug, name) values ($1, 'acme', 'dup')`, [
          randomUUID(),
        ]),
      ),
    ).toMatch(/tenants_slug_unique/);
    for (const stmt of UP) await client.query(stmt);
    const again = await tenants();
    for (const t of again) expect(t).toMatchObject({ root_id: t.id, depth: 0, path: `/${t.id}/` });
  });
});

describe('tenant tree service', () => {
  let n: TestNode;
  const operator = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });
  const plain = (tenantId: string): Principal => ({
    ...operator(),
    tenantId,
    platformAdmin: false,
  });

  beforeAll(async () => {
    n = await testNode({ OAX_TENANT_MAX_DEPTH: '3', OAX_TENANT_MAX_NODES_PER_ROOT: '8' });
  });
  afterAll(async () => {
    await n.close();
  });

  it('creates roots as before (no behaviour change for flat installs)', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: { slug: 'flat', name: 'Flat' },
    });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(
      ['createdAt', 'id', 'monthlyBudgetUsd', 'name', 'secretRefs', 'slug'].sort(),
    );
    const root = await n.services.tenants.tree.node(res.json().id);
    expect(root).toMatchObject({ parentId: null, rootId: root!.id, depth: 0 });
    const dup = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: { slug: 'flat', name: 'Again' },
    });
    expect(dup.statusCode).toBe(409);
    const def = await n.services.tenants.tree.node(DEFAULT_TENANT_ID);
    expect(def).toMatchObject({ parentId: null, rootId: DEFAULT_TENANT_ID, depth: 0 });
  });

  it('builds a tree and answers ancestor, descendant, subtree and slug path queries', async () => {
    const t = n.services.tenants;
    const org = await t.create(operator(), { slug: 'acme', name: 'Acme' });
    const div = await t.createChild(operator(), org.id, { slug: 'div-a', name: 'Division A' });
    const team = await t.createChild(operator(), div.id, { slug: 'team-a', name: 'Team A' });
    const other = await t.createChild(operator(), org.id, { slug: 'div-b', name: 'Division B' });
    expect(team).toMatchObject({ parentId: div.id, rootId: org.id, depth: 2 });
    expect(team.path).toBe(`${div.path}${team.id}/`);

    expect((await t.tree.ancestors(team)).map((x) => x.slug)).toEqual(['acme', 'div-a']);
    expect(await t.tree.ancestors(org)).toEqual([]);
    expect((await t.tree.descendants(org)).map((x) => x.slug)).toEqual([
      'div-a',
      'div-b',
      'team-a',
    ]);
    expect((await t.tree.subtree(div)).map((x) => x.slug)).toEqual(['div-a', 'team-a']);
    expect((await t.tree.children(org.id)).map((x) => x.id)).toEqual([div.id, other.id]);
    expect(await t.tree.descendants(team)).toEqual([]);
    expect(await t.tree.sizeOf(org.id)).toBe(4);
    expect((await t.tree.roots()).map((x) => x.slug)).toContain('acme');
    expect((await t.tree.resolveSlugPath('acme/div-a/team-a'))?.id).toBe(team.id);
    expect(await t.tree.resolveSlugPath('acme/div-b/team-a')).toBeUndefined();
    expect(await t.tree.resolveSlugPath('nope/x')).toBeUndefined();
    expect(() => t.tree.resolveSlugPath('Bad/Slug')).rejects.toThrow();
  });

  it('keeps the tree invisible to other tenants and to the existing API', async () => {
    const t = n.services.tenants;
    const org = await t.tree.resolveSlugPath('acme');
    const team = await t.tree.resolveSlugPath('acme/div-a/team-a');
    // a user of the root cannot read its descendants (visibility arrives with W13-6)
    expect((await t.list(plain(org!.id))).map((x) => x.id)).toEqual([org!.id]);
    await expect(t.get(plain(org!.id), team!.id)).rejects.toMatchObject({ statusCode: 404 });
    // and the child cannot see its parent
    await expect(t.get(plain(team!.id), org!.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      t.createChild(plain(org!.id), org!.id, { slug: 'x', name: 'x' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const res = await n.req({ method: 'GET', url: `/v1/tenants/${team!.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('path');
    expect(res.json()).not.toHaveProperty('parentId');
  });

  it('refuses unknown parents, slug clashes, depth and node limits', async () => {
    const t = n.services.tenants;
    const org = (await t.tree.resolveSlugPath('acme'))!;
    await expect(
      t.createChild(operator(), randomUUID(), { slug: 'x', name: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      t.createChild(operator(), org.id, { slug: 'div-a', name: 'dup' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // overlap in secret names is refused across the whole installation
    await expect(
      t.createChild(operator(), org.id, { slug: 'div', name: 'overlap' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // OAX_TENANT_MAX_DEPTH=3: acme(0) / div-a(1) / team-a(2) / level3(3) / level4 is too deep
    const team = (await t.tree.resolveSlugPath('acme/div-a/team-a'))!;
    const l3 = await t.createChild(operator(), team.id, { slug: 'level-three', name: 'L3' });
    expect(l3.depth).toBe(3);
    await expect(
      t.createChild(operator(), l3.id, { slug: 'level-four', name: 'L4' }),
    ).rejects.toMatchObject({ code: 'tenant_depth_exceeded' });
    // OAX_TENANT_MAX_NODES_PER_ROOT=8
    for (let i = 0; i < 3; i++)
      await t.createChild(operator(), org.id, { slug: `fill${'xyz'[i % 3]}${i}-q`, name: 'f' });
    expect(await t.tree.sizeOf(org.id)).toBe(8);
    await expect(
      t.createChild(operator(), org.id, { slug: 'one-more', name: 'x' }),
    ).rejects.toMatchObject({ code: 'tenant_node_limit_exceeded' });
  });

  it('audits child creation and keeps the audit chain valid', async () => {
    const v = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(v.statusCode).toBe(200);
    expect(v.json().valid).toBe(true);
    expect(v.json().checkedEntries).toBeGreaterThan(5);
  });
});
