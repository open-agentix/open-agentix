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
import { tenants as tenantsTable } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
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
  /** Runs a multi-statement script on one connection; a failure inside BEGIN/COMMIT rolls back. */
  script(q: string): Promise<unknown>;
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
  /** Connection string for a control node on this database (memory:// for PGlite). */
  url: string;
}

const PG_URL = process.env.OAX_TEST_DATABASE_URL;

async function openPglite(): Promise<Sql> {
  const c = new PGlite();
  return {
    query: (q, params) => c.query(q, params) as never,
    exec: (q) => c.exec(q),
    script: (q) =>
      c.exec(q).catch(async (e: unknown) => {
        await c.exec('rollback');
        throw e;
      }),
    url: 'memory://',
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
    url: url.toString(),
    script: async (q) => {
      const c = await pool.connect();
      try {
        return await c.query(q);
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
    migrate: (folder) => migratePg(drizzlePg(pool) as never, { migrationsFolder: folder }),
    close: async () => {
      await pool.end();
      // No `with (force)`: terminating a connection that is still closing surfaces as an uncaught
      // error of the application pool. Wait until the server has seen every client leave instead.
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`drop database ${name}`);
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== '55006' || attempt >= 50) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
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
    // later migrations go too: drizzle skips a migration older than the last one applied
    journal.entries = journal.entries.filter((e) => e.tag < '0013');
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

  it('matches the drizzle snapshot of schema.ts (columns, indexes, constraints)', async () => {
    const snap = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta/0018_snapshot.json'), 'utf8'),
    ).tables['public.tenants'] as {
      columns: Record<string, { name: string; notNull: boolean }>;
      indexes: Record<string, unknown>;
      foreignKeys: Record<string, unknown>;
      checkConstraints: Record<string, unknown>;
      uniqueConstraints: Record<string, unknown>;
    };
    const names = async (q: string) =>
      (await client.query<{ n: string }>(q)).rows.map((r) => r.n).sort();
    const cols = (
      await client.query<{ n: string; nn: boolean }>(
        `select column_name n, is_nullable = 'NO' nn from information_schema.columns where table_name = 'tenants'`,
      )
    ).rows;
    expect(cols.map((c) => c.n).sort()).toEqual(Object.keys(snap.columns).sort());
    for (const c of cols) expect(c.nn, c.n).toBe(snap.columns[c.n]!.notNull);
    expect(
      await names(
        `select indexname n from pg_indexes where tablename = 'tenants' and indexname not like '%_pkey' and indexname not like '%_unique'`,
      ),
    ).toEqual(Object.keys(snap.indexes).sort());
    const con = (t: string) =>
      names(
        `select conname n from pg_constraint where conrelid = 'tenants'::regclass and contype = '${t}'`,
      );
    expect(await con('f')).toEqual(Object.keys(snap.foreignKeys).sort());
    expect(await con('c')).toEqual(Object.keys(snap.checkConstraints).sort());
    expect(await con('u')).toEqual(Object.keys(snap.uniqueConstraints).sort());
  });

  it('is idempotent: running the statements again changes nothing', async () => {
    const before = await tenants();
    for (const stmt of UP) await client.query(stmt);
    for (const stmt of UP) await client.query(stmt);
    expect(await tenants()).toEqual(before);
  });

  it('keeps slugs globally unique (secret namespace) in addition to the sibling index', async () => {
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
    // Global UNIQUE(slug) stays until secrets are node-aware (W13-7): no repeats below other
    // parents, nor between a root and a child.
    expect(await failure(place(randomUUID(), B, 'sales'))).toMatch(/tenants_slug_unique/);
    expect(await failure(place(randomUUID(), c1, 'sales'))).toMatch(/tenants_slug_unique/);
    expect(await failure(place(randomUUID(), B, 'acme'))).toMatch(/tenants_slug_unique/);
    await place(randomUUID(), B, 'other');
    const sub = (
      await client.query('select id from tenants where path like $1 order by depth', [`/${A}/%`])
    ).rows;
    expect(sub).toHaveLength(2); // A and sales; not B's subtree
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
    expect(await failure(client.script(DOWN))).toMatch(/nested tenants exist/);
  });

  it('can be reverted without nested tenants and re-applied', async () => {
    for (let d = 32; d >= 1; d--) await client.query('delete from tenants where depth = $1', [d]);
    await client.script(DOWN);
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
      [
        'createdAt',
        'depth',
        'id',
        'monthlyBudgetUsd',
        'name',
        'parentId',
        'secretRefs',
        'slug',
        'slugPath',
      ].sort(),
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

  it('keeps the tree invisible to other tenants and its internals out of the API', async () => {
    const t = n.services.tenants;
    const org = await t.tree.resolveSlugPath('acme');
    const team = await t.tree.resolveSlugPath('acme/div-a/team-a');
    // a user of the root cannot read its descendants (only a tenant admin reaches below the home node until W13-6, see tenant-tree-api.test.ts)
    expect((await t.list(plain(org!.id))).map((x) => x.id)).toEqual([org!.id]);
    await expect(t.get(plain(org!.id), team!.id)).rejects.toMatchObject({ statusCode: 404 });
    // and the child cannot see its parent
    await expect(t.get(plain(team!.id), org!.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      t.createChild(plain(org!.id), org!.id, { slug: 'x', name: 'x' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const res = await n.req({ method: 'GET', url: `/v1/tenants/${team!.id}` });
    expect(res.statusCode).toBe(200);
    // only the additive tree fields of A3 are exposed, never the materialised id path or the root id
    expect(res.json()).toMatchObject({ slugPath: 'acme/div-a/team-a', depth: 2 });
    expect(res.json()).not.toHaveProperty('path');
    expect(res.json()).not.toHaveProperty('rootId');
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

describe.each(targets)('tenant tree: races, acting in, deletion (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let n: TestNode;
  let db: Sql;
  const operator = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });

  beforeAll(async () => {
    db = await open();
    n = await testNode({
      OAX_DATABASE_URL: db.url,
      OAX_TENANT_MAX_NODES_PER_ROOT: '6',
    });
  });
  afterAll(async () => {
    await n.close();
    await db.close();
  });

  const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
  const statusOf = (r: PromiseSettledResult<unknown>) =>
    r.status === 'rejected' ? (r.reason as { statusCode?: number }).statusCode : 0;

  it('lets exactly one of several parallel creations with the same slug under different parents win', async () => {
    const t = n.services.tenants;
    const a = await t.create(operator(), { slug: 'race-a', name: 'A' });
    const b = await t.create(operator(), { slug: 'race-b', name: 'B' });
    const results = await settle([
      t.createChild(operator(), a.id, { slug: 'shared', name: '1' }),
      t.createChild(operator(), b.id, { slug: 'shared', name: '2' }),
      t.createChild(operator(), a.id, { slug: 'shared', name: '3' }),
      t.createChild(operator(), b.id, { slug: 'shared', name: '4' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(statusOf(r)).toBe(409);
    const rows = await n.ctx.db.select().from(tenantsTable).where(eq(tenantsTable.slug, 'shared'));
    expect(rows).toHaveLength(1);
  });

  it('lets exactly one of a root and a child with the same slug win', async () => {
    const t = n.services.tenants;
    const org = await t.create(operator(), { slug: 'race-c', name: 'C' });
    const results = await settle([
      t.create(operator(), { slug: 'dupe-name', name: 'root' }),
      t.createChild(operator(), org.id, { slug: 'dupe-name', name: 'child' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(statusOf).sort()).toEqual([0, 409]);
  });

  it('refuses parallel creations of slugs that overlap in secret names', async () => {
    const t = n.services.tenants;
    const results = await settle([
      t.create(operator(), { slug: 'ovl.corp-x', name: '1' }),
      t.create(operator(), { slug: 'ovl-corp.x', name: '2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('never exceeds the node limit under parallel creation', async () => {
    const t = n.services.tenants;
    const org = await t.create(operator(), { slug: 'race-limit', name: 'L' });
    const results = await settle(
      Array.from({ length: 12 }, (_, i) =>
        t.createChild(operator(), org.id, { slug: `lim-${'abcdefghijkl'[i]}-q`, name: 'n' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5); // root + 5 = 6
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect(r).toMatchObject({ reason: { code: 'tenant_node_limit_exceeded' } });
    expect(await t.tree.sizeOf(org.id)).toBe(6);
  });

  it('rolls back the tenant when the audit append fails', async () => {
    const t = n.services.tenants;
    const org = await t.create(operator(), { slug: 'race-rollback', name: 'R' });
    const orig = n.services.audit.append.bind(n.services.audit);
    n.services.audit.append = () => Promise.reject(new Error('audit down'));
    try {
      await expect(
        t.createChild(operator(), org.id, { slug: 'rolled-back', name: 'x' }),
      ).rejects.toThrow('audit down');
    } finally {
      n.services.audit.append = orig;
    }
    expect(await t.tree.resolveSlugPath('race-rollback/rolled-back')).toBeUndefined();
  });

  it('acts inside a child by slug or id; others still get 404', async () => {
    const t = n.services.tenants;
    const idn = n.services.identity;
    const org = await t.create(operator(), { slug: 'act-org', name: 'Act' });
    const child = await t.createChild(operator(), org.id, { slug: 'act-child', name: 'Child' });
    const op = operator();
    expect((await idn.actingIn(op, 'act-child')).tenantId).toBe(child.id);
    expect((await idn.actingIn(op, child.id)).tenantId).toBe(child.id);
    const rootUser: Principal = { ...op, tenantId: org.id, platformAdmin: false };
    await expect(idn.actingIn(rootUser, 'act-child')).rejects.toMatchObject({ statusCode: 404 });
    expect(await idn.actingIn(rootUser, 'act-org')).toBe(rootUser);
    const childUser: Principal = { ...op, tenantId: child.id, platformAdmin: false };
    await expect(idn.actingIn(childUser, 'act-org')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('restricts deleting a root while it has descendants', async () => {
    const t = n.services.tenants;
    const org = await t.create(operator(), { slug: 'del-org', name: 'Del' });
    const child = await t.createChild(operator(), org.id, { slug: 'del-child', name: 'Child' });
    await expect(
      n.ctx.db.delete(tenantsTable).where(eq(tenantsTable.id, org.id)),
    ).rejects.toBeTruthy();
    expect(await t.tree.node(org.id)).toBeDefined();
    await n.ctx.db.delete(tenantsTable).where(eq(tenantsTable.id, child.id));
    await n.ctx.db.delete(tenantsTable).where(eq(tenantsTable.id, org.id));
    expect(await t.tree.node(org.id)).toBeUndefined();
  });
});
