import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0023 (ADR 0014 slice S4, #226): `tenant_role_bindings.source` separates the mirror of
 * `users.global_roles` from explicit grants. Existing rows are classified by shape, the unique key
 * and the 0019 trigger honour the source, and the down script restores the old key. Runs on PGlite
 * and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0023_trb_source';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0023 files', () => {
  it('is ordered in the journal and has a snapshot and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    const at = tags.indexOf(TAG);
    expect(at).toBeGreaterThan(0);
    expect(tags[at - 1]! < TAG).toBe(true);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(tags).size).toBe(tags.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const snap = read('0023');
    const table = snap.tables['public.tenant_role_bindings'];
    expect(table.columns.source).toMatchObject({
      type: 'text',
      notNull: true,
      default: "'mirror'",
    });
    expect(table.indexes.trb_uq.columns.map((x: { expression: string }) => x.expression)).toContain(
      'source',
    );
    expect(Object.keys(table.checkConstraints)).toContain('trb_source_check');
    // Chained to the snapshot numbered 0022 (the OpenTelemetry slice's run_node_sessions.otel_session)
    // once that one is part of the tree; until then it points at the id that snapshot will carry.
    const previous = join(MIGRATIONS_FOLDER, 'meta/0022_snapshot.json');
    if (existsSync(previous)) expect(snap.prevId).toBe(read('0022').id);
    else expect(snap.prevId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0023 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const child = randomUUID();
  const other = randomUUID();
  const u = { a: randomUUID(), b: randomUUID(), mover: randomUUID() };
  const rowsOf = async (user: string) =>
    (
      await c.query<{ tenant_id: string; role: string; source: string; inherit: boolean }>(
        `select tenant_id, role, source, inherit from tenant_role_bindings where user_id = $1`,
        [user],
      )
    ).rows
      .map(
        (r) =>
          `${r.tenant_id === root ? 'root' : r.tenant_id === child ? 'child' : 'x'}|${r.role}|${r.source}${r.inherit ? '|inh' : ''}`,
      )
      .sort();
  const ins = (user: string, tenant: string, role: string, extra = '', cols = '') =>
    c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role${cols ? `, ${cols}` : ''})
       values ($1, $2, $3, $4${extra ? `, ${extra}` : ''})`,
      [randomUUID(), user, tenant, role],
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
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
    const user = (id: string, tenant: string, roles: string[]) =>
      c.query(
        `insert into users (id, email, display_name, source, global_roles, tenant_id)
         values ($1, $2, 'U', 'local', $3, $4)`,
        [id, `${id}@example.org`, roles, tenant],
      );
    await user(u.a, root, ['admin', 'viewer']);
    await user(u.b, root, ['operator']);
    await user(u.mover, root, ['auditor']);
    // the mirror rows the application wrote for global_roles (the users are newer than migration 0018)
    for (const [who, roles] of [
      [u.a, ['admin', 'viewer']],
      [u.b, ['operator']],
      [u.mover, ['auditor']],
    ] as const)
      for (const role of roles) await ins(who, root, role);
    // shapes the mirror cannot have written (S2 and the demo seed bind inheriting rows by hand)
    await ins(u.a, root, 'auditor', 'true', 'inherit'); // inheriting, on the home node
    await ins(u.a, child, 'integrator'); // not the home node
    await ins(u.b, root, 'viewer', `now() + interval '1 day'`, 'expires_at'); // expiring
    await ins(u.b, root, 'pentest', `now() + interval '1 day'`, 'expires_at');
    await ins(u.b, root, 'integrator', `'uc'`, 'use_case');
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps mirror-shaped rows as mirror and turns every other shape into a grant', async () => {
    expect(await rowsOf(u.a)).toEqual(
      [
        'root|admin|mirror',
        'root|viewer|mirror',
        'root|auditor|grant|inh',
        'child|integrator|grant',
      ].sort(),
    );
    expect(await rowsOf(u.b)).toEqual(
      [
        'root|operator|mirror',
        'root|viewer|grant',
        'root|pentest|grant',
        'root|integrator|grant',
      ].sort(),
    );
  });

  it('makes the source part of the unique key and refuses unknown sources', async () => {
    await ins(u.a, root, 'admin', `'grant'`, 'source'); // same key as the mirror row, other source
    expect(await failure(ins(u.a, root, 'admin', `'grant'`, 'source'))).toMatch(/trb_uq|duplicate/);
    expect(await failure(ins(u.a, root, 'viewer', `'other'`, 'source'))).toMatch(
      /trb_source_check|check/,
    );
    await c.query(
      `delete from tenant_role_bindings where user_id = $1 and role = 'admin' and source = 'grant'`,
      [u.a],
    );
  });

  it('the global_roles trigger touches mirror rows only', async () => {
    await ins(u.mover, root, 'auditor', `'grant'`, 'source'); // explicit grant next to the mirror row
    await ins(u.mover, root, 'operator', `'grant'`, 'source'); // explicit grant of an unlisted role
    await c.query(`update users set global_roles = '{}' where id = $1`, [u.mover]);
    expect(await rowsOf(u.mover)).toEqual(['root|auditor|grant', 'root|operator|grant']);
    // a home move inside the organisation: mirror rows follow, grants stay
    await c.query(`update users set global_roles = '{viewer}' where id = $1`, [u.mover]);
    await c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'viewer')`,
      [randomUUID(), u.mover, root],
    );
    await c.query(`update users set tenant_id = $2 where id = $1`, [u.mover, child]);
    expect(await rowsOf(u.mover)).toEqual([
      'child|viewer|mirror',
      'root|auditor|grant',
      'root|operator|grant',
    ]);
    // grants of the old organisation still block a move out of it
    expect(
      await failure(c.query(`update users set tenant_id = $2 where id = $1`, [u.mover, other])),
    ).toMatch(/outside the organisation/);
  });

  it('is idempotent: running the migration again changes nothing', async () => {
    const before = [await rowsOf(u.a), await rowsOf(u.b), await rowsOf(u.mover)];
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) await c.exec(statement);
    expect([await rowsOf(u.a), await rowsOf(u.b), await rowsOf(u.mover)]).toEqual(before);
  });

  it('the down script restores the old key and the old trigger', async () => {
    // a grant sharing its key with a mirror row cannot survive the old unique index
    await ins(u.a, root, 'viewer', `'grant'`, 'source');
    await c.script(DOWN);
    const cols = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'tenant_role_bindings'`,
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain('source');
    const a = (
      await c.query<{ tenant_id: string; role: string }>(
        `select tenant_id, role from tenant_role_bindings where user_id = $1 and role = 'viewer'`,
        [u.a],
      )
    ).rows;
    expect(a).toHaveLength(1);
    expect(await failure(ins(u.a, root, 'viewer'))).toMatch(/trb_uq|duplicate/);
    // the old trigger revokes every row of the key again, whatever it was
    await c.query(`update users set global_roles = '{}' where id = $1`, [u.a]);
    const left = await c.query(
      `select 1 from tenant_role_bindings where user_id = $1 and tenant_id = $2 and use_case is null and role in ('admin','viewer','auditor')`,
      [u.a, root],
    );
    expect(left.rows).toHaveLength(0);
  });
});
