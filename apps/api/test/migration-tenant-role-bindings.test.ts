import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveAt, isGrantableRole, sameBindings, type Role } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlState, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0018 (ADR 0014 slice S1) on a database that already holds users, tenants and
 * `global_roles`: backfill equivalence, the organisation trigger, constraints and the down path.
 * Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0018_tenant_role_bindings';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0018 files', () => {
  it('is the next free number after 0017 and has a snapshot and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0017_approvals_tenant_status_idx') + 1);
    expect(tags.at(-1)).toBe(TAG);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(existsSync(join(MIGRATIONS_FOLDER, 'meta/0018_snapshot.json'))).toBe(true);
    const snap = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta/0018_snapshot.json'), 'utf8'),
    );
    expect(Object.keys(snap.tables)).toContain('public.tenant_role_bindings');
    expect(Object.keys(snap.tables)).toContain('public.tenant_role_restrictions');
  });
});

describe.each(sqlTargets)('migration 0018 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  // organisation A: root, one child, one grandchild; organisation B: a root.
  const root = DEFAULT_TENANT_ID;
  const child = randomUUID();
  const grand = randomUUID();
  const sibling = randomUUID();
  const orgB = randomUUID();
  const u = {
    admin: randomUUID(), // home root: admin, viewer, viewer (duplicate)
    multi: randomUUID(), // home child: auditor, integrator
    none: randomUUID(), // no roles
    odd: randomUUID(), // roles the application ignores today: root, pentest, plus operator
    other: randomUUID(), // home orgB: integrator
  };
  const bindings = async (where = '') =>
    (
      await c.query<{
        user_id: string;
        tenant_id: string;
        role: string;
        inherit: boolean;
        use_case: string | null;
        expires_at: Date | null;
        granted_by: string | null;
      }>(`select * from tenant_role_bindings ${where} order by user_id, role`)
    ).rows;

  const place = (id: string, parent: string | null, parentPath: string, depth: number) =>
    c.query(
      `insert into tenants (id, slug, name, parent_id, root_id, path, depth)
       values ($1, $2, $2, $3, $4, $5, $6)`,
      [
        id,
        `n-${id.slice(0, 8)}`,
        parent,
        parent ? root : id,
        parent ? `${parentPath}${id}/` : `/${id}/`,
        depth,
      ],
    );

  beforeAll(async () => {
    // A copy of the migrations without 0018 = the database as it is before the upgrade.
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    c = await open();
    await c.migrate(dir);
    const rootPath = `/${root}/`;
    await place(child, root, rootPath, 1);
    await place(sibling, root, rootPath, 1);
    await place(grand, child, `${rootPath}${child}/`, 2);
    await place(orgB, null, '', 0);
    const user = (id: string, tenant: string, roles: string[]) =>
      c.query(
        `insert into users (id, email, display_name, source, global_roles, tenant_id)
         values ($1, $2, 'U', 'local', $3, $4)`,
        [id, `${id}@example.org`, roles, tenant],
      );
    await user(u.admin, root, ['admin', 'viewer', 'viewer']);
    await user(u.multi, child, ['auditor', 'integrator']);
    await user(u.none, root, []);
    await user(u.odd, grand, ['root', 'pentest', 'operator']);
    await user(u.other, orgB, ['integrator']);
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('backfills every legacy role as a non-inheriting binding on the home tenant', async () => {
    const rows = await bindings();
    expect(rows.map((r) => `${r.user_id}|${r.tenant_id}|${r.role}`).sort()).toEqual(
      [
        `${u.admin}|${root}|admin`,
        `${u.admin}|${root}|viewer`,
        `${u.multi}|${child}|auditor`,
        `${u.multi}|${child}|integrator`,
        `${u.odd}|${grand}|operator`,
        `${u.other}|${orgB}|integrator`,
      ].sort(),
    );
    for (const r of rows) {
      expect(r.inherit).toBe(false);
      expect(r.use_case).toBeNull();
      expect(r.expires_at).toBeNull();
      expect(r.granted_by).toBeNull();
    }
  });

  it("changes nobody's access: the resolver gives every user what global_roles gave before", async () => {
    const users = (
      await c.query<{ id: string; tenant_id: string; global_roles: string[] }>(
        `select id, tenant_id, global_roles from users`,
      )
    ).rows;
    const nodes = (
      await c.query<{ id: string; root_id: string; path: string }>(
        `select id, root_id, path from tenants`,
      )
    ).rows.map((t) => ({ id: t.id, rootId: t.root_id, path: t.path }));
    const rows = await bindings();
    for (const user of users) {
      const home = nodes.find((x) => x.id === user.tenant_id)!;
      // what the application derived from global_roles before the migration
      const before = [...new Set(user.global_roles.filter(isGrantableRole))].map((role) => ({
        role,
        teamId: null,
      }));
      const raw = {
        userId: user.id,
        homeTenantId: home.id,
        homeRootId: home.rootId,
        platformAdmin: false,
        nodeBindings: rows
          .filter((r) => r.user_id === user.id)
          .map((r) => ({
            tenantId: r.tenant_id,
            role: r.role as Role,
            useCase: r.use_case,
            inherit: r.inherit,
            expiresAt: r.expires_at,
          })),
        teamBindings: [],
        agentBindings: [],
      };
      // at the home node, and nowhere else: a node binding reaches no other node
      for (const node of nodes) {
        const got = effectiveAt(raw, node, { now: new Date() });
        if (node.id === home.id) expect(sameBindings(got, before), user.id).toBe(true);
        else expect(got, `${user.id} at ${node.id}`).toEqual([]);
      }
    }
  });

  it('keeps users.global_roles untouched (it stays the source of truth for one release)', async () => {
    const { rows } = await c.query<{ global_roles: string[] }>(
      `select global_roles from users where id = $1`,
      [u.odd],
    );
    expect(rows[0]!.global_roles).toEqual(['root', 'pentest', 'operator']);
  });

  it('is idempotent: running the migration again adds nothing', async () => {
    const before = (await bindings()).length;
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) await c.exec(statement);
    expect(await bindings()).toHaveLength(before);
  });

  it('adds the authz epoch to tenants, zero everywhere', async () => {
    const { rows } = await c.query<{ authz_epoch: string | number }>(
      `select authz_epoch from tenants`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.authz_epoch)).toBe(0);
  });

  describe('trigger trb_same_org', () => {
    const insert = (user: string, tenant: string) =>
      c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit)
         values ($1, $2, $3, 'viewer', true)`,
        [randomUUID(), user, tenant],
      );

    it('refuses a binding in another organisation, also an inheriting one', async () => {
      expect(await sqlState(insert(u.admin, orgB))).toBe('23514');
      expect(await failure(insert(u.other, root))).toMatch(/outside the home organisation/);
      expect(await sqlState(insert(u.other, child))).toBe('23514');
    });

    it('accepts any node of the home organisation: ancestor, sibling, descendant', async () => {
      // legitimate: an organisation admin whose home is a child, bound on the root
      await insert(u.multi, root);
      await insert(u.multi, sibling);
      await insert(u.multi, grand);
      expect(
        (await bindings(`where user_id = '${u.multi}' and role = 'viewer'`))
          .map((r) => r.tenant_id)
          .sort(),
      ).toEqual([root, sibling, grand].sort());
    });

    it('refuses to move a binding to another organisation', async () => {
      expect(
        await sqlState(
          c.query(
            `update tenant_role_bindings set tenant_id = $1 where user_id = $2 and tenant_id = $3`,
            [orgB, u.multi, sibling],
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          c.query(
            `update tenant_role_bindings set user_id = $1 where user_id = $2 and tenant_id = $3`,
            [u.other, u.multi, sibling],
          ),
        ),
      ).toBe('23514');
    });

    it('refuses an unknown node or user (foreign keys first, trigger as backstop)', async () => {
      expect(await sqlState(insert(u.admin, randomUUID()))).toBeDefined();
      expect(await sqlState(insert(randomUUID(), root))).toBeDefined();
    });

    it('guards the other side: a user with bindings cannot move to another organisation', async () => {
      expect(
        await sqlState(c.query(`update users set tenant_id = $1 where id = $2`, [orgB, u.admin])),
      ).toBe('23514');
      // inside the organisation it is fine, and a user without bindings may move anywhere
      await c.query(`update users set tenant_id = $1 where id = $2`, [sibling, u.admin]);
      await c.query(`update users set tenant_id = $1 where id = $2`, [root, u.admin]);
      await c.query(`update users set tenant_id = $1 where id = $2`, [orgB, u.none]);
      await c.query(`update users set tenant_id = $1 where id = $2`, [root, u.none]);
      // once the bindings are gone, the user may leave
      await c.query(`delete from tenant_role_bindings where user_id = $1`, [u.admin]);
      await c.query(`update users set tenant_id = $1 where id = $2`, [orgB, u.admin]);
      await c.query(`update users set tenant_id = $1 where id = $2`, [root, u.admin]);
      await c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'admin'), ($4, $2, $3, 'viewer')`,
        [randomUUID(), u.admin, root, randomUUID()],
      );
    });
  });

  describe('constraints', () => {
    const row = (over: Record<string, unknown>) => {
      const v = {
        id: randomUUID(),
        user_id: u.admin,
        tenant_id: child,
        role: 'operator',
        use_case: null,
        expires_at: null,
        ...over,
      };
      return c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role, use_case, expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [v.id, v.user_id, v.tenant_id, v.role, v.use_case, v.expires_at],
      );
    };

    it('accepts only the seven fixed roles', async () => {
      expect(await failure(row({ role: 'root' }))).toMatch(/trb_role_check/);
      expect(await failure(row({ role: '' }))).toMatch(/trb_role_check/);
    });

    it('requires an expiry for pentest', async () => {
      expect(await failure(row({ role: 'pentest' }))).toMatch(/trb_pentest_expiry/);
      await row({ role: 'pentest', expires_at: new Date(Date.now() + 86_400_000) });
    });

    it('is unique per user, node, role and use case (null counts as empty)', async () => {
      await row({ role: 'auditor' });
      expect(await sqlState(row({ role: 'auditor' }))).toBe('23505');
      await row({ role: 'auditor', use_case: 'security' });
      expect(await sqlState(row({ role: 'auditor', use_case: 'security' }))).toBe('23505');
    });

    it('limits the use case length', async () => {
      expect(await failure(row({ role: 'integrator', use_case: '' }))).toMatch(/trb_use_case_len/);
      expect(await failure(row({ role: 'integrator', use_case: 'x'.repeat(201) }))).toMatch(
        /trb_use_case_len/,
      );
    });

    it('never allows a restriction on admin and only known roles', async () => {
      const restrict = (role: string) =>
        c.query(
          `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, $2, 'agents:write')`,
          [child, role],
        );
      expect(await failure(restrict('admin'))).toMatch(/trr_not_admin/);
      expect(await failure(restrict('root'))).toMatch(/trr_role_check/);
      await restrict('operator');
      expect(await sqlState(restrict('operator'))).toBe('23505');
    });

    it('cascades when the user or the node is deleted', async () => {
      const gone = randomUUID();
      await c.query(
        `insert into users (id, email, display_name, source, tenant_id) values ($1, $2, 'G', 'local', $3)`,
        [gone, `${gone}@example.org`, grand],
      );
      await c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'viewer')`,
        [randomUUID(), gone, grand],
      );
      await c.query(`delete from users where id = $1`, [gone]);
      expect(await bindings(`where user_id = '${gone}'`)).toHaveLength(0);
    });

    it('records granted_by and clears it when the grantor is deleted', async () => {
      const by = randomUUID();
      await c.query(
        `insert into users (id, email, display_name, source, tenant_id) values ($1, $2, 'B', 'local', $3)`,
        [by, `${by}@example.org`, root],
      );
      const id = randomUUID();
      await c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role, granted_by) values ($1, $2, $3, 'viewer', $4)`,
        [id, u.none, root, by],
      );
      await c.query(`delete from users where id = $1`, [by]);
      const { rows } = await c.query<{ granted_by: string | null }>(
        `select granted_by from tenant_role_bindings where id = $1`,
        [id],
      );
      expect(rows[0]!.granted_by).toBeNull();
    });
  });

  it('serialises a binding insert against a concurrent change of the home organisation', async (ctx) => {
    if (!c.session) return ctx.skip();
    const user = randomUUID();
    await c.query(
      `insert into users (id, email, display_name, source, tenant_id) values ($1, $2, 'R', 'local', $3)`,
      [user, `${user}@example.org`, root],
    );
    const a = await c.session();
    const b = await c.session();
    try {
      await a.query('begin');
      await a.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'viewer')`,
        [randomUUID(), user, root],
      );
      await b.query('begin');
      // blocks on the row lock the insert holds (FOR SHARE), then sees the binding and refuses
      const move = b.query(`update users set tenant_id = $1 where id = $2`, [orgB, user]).then(
        () => 'moved',
        (e: { code?: string }) => e.code,
      );
      await new Promise((r) => setTimeout(r, 300));
      await a.query('commit');
      expect(await move).toBe('23514');
      await b.query('rollback');
    } finally {
      a.release();
      b.release();
    }
  });

  it('serialises the other order too: a home change first makes the waiting insert fail closed', async (ctx) => {
    if (!c.session) return ctx.skip();
    const user = randomUUID();
    await c.query(
      `insert into users (id, email, display_name, source, tenant_id) values ($1, $2, 'R', 'local', $3)`,
      [user, `${user}@example.org`, root],
    );
    const a = await c.session();
    const b = await c.session();
    try {
      await b.query('begin');
      await b.query(`update users set tenant_id = $1 where id = $2`, [orgB, user]);
      await a.query('begin');
      // waits for the user row (FOR SHARE in the trigger); after the move commits, the re-checked
      // join no longer finds the old home and the binding in the old organisation is refused
      const insert = a
        .query(
          `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'viewer')`,
          [randomUUID(), user, root],
        )
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        );
      await new Promise((r) => setTimeout(r, 300));
      await b.query('commit');
      expect(await insert).toBe('23514');
      await a.query('rollback');
      // (the pool has two connections, both held here: read through one of them)
      const rows = await b.query(`select 1 from tenant_role_bindings where user_id = $1`, [user]);
      expect(rows.rows).toHaveLength(0);
    } finally {
      a.release();
      b.release();
    }
  });

  it('is reverted by the down script, which keeps users and global_roles, and can run twice', async () => {
    const before = (await c.query(`select id, global_roles, tenant_id from users order by id`))
      .rows;
    await c.script(DOWN);
    await c.script(DOWN);
    const tables = (
      await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      )
    ).rows.map((r) => r.table_name);
    expect(tables).not.toContain('tenant_role_bindings');
    expect(tables).not.toContain('tenant_role_restrictions');
    const cols = (
      await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'tenants'`,
      )
    ).rows.map((r) => r.column_name);
    expect(cols).not.toContain('authz_epoch');
    const fns = (
      await c.query<{ proname: string }>(
        `select proname from pg_proc where proname in ('trb_same_org', 'trb_users_home_guard')`,
      )
    ).rows;
    expect(fns).toEqual([]);
    const trigs = (
      await c.query<{ tgname: string }>(`select tgname from pg_trigger where tgname like 'trb_%'`)
    ).rows;
    expect(trigs).toEqual([]);
    expect(
      (await c.query(`select id, global_roles, tenant_id from users order by id`)).rows,
    ).toEqual(before);
    // users can change organisation again once the guard is gone
    await c.query(`update users set tenant_id = $1 where id = $2`, [orgB, u.admin]);
    await c.query(`update users set tenant_id = $1 where id = $2`, [root, u.admin]);
  });

  it('migrates up again after a rollback and rebuilds the same backfill', async () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) await c.exec(statement);
    expect((await bindings()).map((r) => `${r.user_id}|${r.tenant_id}|${r.role}`).sort()).toEqual(
      [
        `${u.admin}|${root}|admin`,
        `${u.admin}|${root}|viewer`,
        `${u.multi}|${child}|auditor`,
        `${u.multi}|${child}|integrator`,
        `${u.odd}|${grand}|operator`,
        `${u.other}|${orgB}|integrator`,
      ].sort(),
    );
  });
});
