import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0030 (ADR 0017 slice S10, #290): `agent-engineer` is renamed to `agent-maintainer`
 * outright. Every table that stores a role is rewritten, the check constraints accept the two new
 * roles and refuse the old one, and the down script refuses while `agent-developer` bindings exist.
 * Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0030_agent_roles';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0030 files', () => {
  it('is ordered in the journal and has a snapshot and a down script', () => {
    const tags = journal.entries.map((e) => e.tag);
    const at = tags.indexOf(TAG);
    expect(at).toBeGreaterThan(0);
    expect(tags[at - 1]! < TAG).toBe(true);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(new Set(tags).size).toBe(tags.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    const snap = read('0030');
    for (const [table, name] of [
      ['tenant_role_bindings', 'trb_role_check'],
      ['tenant_role_restrictions', 'trr_role_check'],
    ] as const) {
      const value: string = snap.tables[`public.${table}`].checkConstraints[name].value;
      expect(value).toContain("'agent-developer','agent-maintainer'");
      expect(value).not.toContain('agent-engineer');
    }
    expect(snap.prevId).toBe(read('0029').id);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0030 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const child = randomUUID();
  const team = randomUUID();
  const agent = randomUUID();
  const u = { eng: randomUUID(), mixed: randomUUID(), plain: randomUUID() };
  const roles = async (sql: string, ...params: unknown[]) =>
    (await c.query<{ r: string }>(sql, params)).rows.map((x) => x.r).sort();
  const bindingRoles = (user: string) =>
    roles(`select role || '|' || source as r from tenant_role_bindings where user_id = $1`, user);
  const globalRoles = async (user: string) =>
    (await c.query<{ g: string[] }>(`select global_roles as g from users where id = $1`, [user]))
      .rows[0]!.g;

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
    const user = (id: string, roles: string[]) =>
      c.query(
        `insert into users (id, email, display_name, source, global_roles, tenant_id)
         values ($1, $2, 'U', 'local', $3, $4)`,
        [id, `${id}@example.org`, roles, root],
      );
    // the mirror rows the application wrote for global_roles, then rows the mirror cannot write
    await user(u.eng, ['agent-engineer', 'viewer']);
    await user(u.mixed, ['admin', 'agent-engineer']);
    await user(u.plain, ['operator']);
    const trb = (who: string, tenant: string, role: string, extra = '') =>
      c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role${extra ? ', inherit, source' : ''})
         values ($1, $2, $3, $4${extra ? ", true, 'grant'" : ''})`,
        [randomUUID(), who, tenant, role],
      );
    await trb(u.eng, root, 'agent-engineer');
    await trb(u.eng, root, 'viewer');
    await trb(u.eng, child, 'agent-engineer', 'inherit');
    await trb(u.mixed, root, 'admin');
    await trb(u.mixed, root, 'agent-engineer');
    await trb(u.plain, root, 'operator');
    await c.query(
      `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, 'agent-engineer', 'tokens:write')`,
      [child],
    );
    await c.query(`insert into teams (id, tenant_id, slug, name) values ($1, $2, 'team', 'Team')`, [
      team,
      root,
    ]);
    await c.query(
      `insert into team_members (team_id, user_id, role) values ($1, $2, 'agent-engineer')`,
      [team, u.eng],
    );
    await c.query(`insert into team_members (team_id, user_id, role) values ($1, $2, 'viewer')`, [
      team,
      u.plain,
    ]);
    await c.query(
      `insert into agents (id, tenant_id, team_id, name, draft_source) values ($1, $2, $3, 'a', 'x')`,
      [agent, root, team],
    );
    await c.query(
      `insert into agent_role_bindings (user_id, agent_id, role) values ($1, $2, 'agent-engineer')`,
      [u.plain, agent],
    );
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites global roles and their mirror rows, keeping everything else', async () => {
    expect(await globalRoles(u.eng)).toEqual(['agent-maintainer', 'viewer']);
    expect(await globalRoles(u.mixed)).toEqual(['admin', 'agent-maintainer']);
    expect(await globalRoles(u.plain)).toEqual(['operator']);
    expect(await bindingRoles(u.eng)).toEqual([
      'agent-maintainer|grant',
      'agent-maintainer|mirror',
      'viewer|mirror',
    ]);
    expect(await bindingRoles(u.mixed)).toEqual(['admin|mirror', 'agent-maintainer|mirror']);
    expect(await bindingRoles(u.plain)).toEqual(['operator|mirror']);
  });

  it('keeps the inheritance flag of an explicit node binding', async () => {
    const r = await c.query<{ inherit: boolean; tenant_id: string }>(
      `select inherit, tenant_id from tenant_role_bindings where user_id = $1 and role = 'agent-maintainer' and source = 'grant'`,
      [u.eng],
    );
    expect(r.rows).toEqual([{ inherit: true, tenant_id: child }]);
  });

  it('rewrites restrictions and team members', async () => {
    expect(await roles(`select role as r from tenant_role_restrictions`)).toEqual([
      'agent-maintainer',
    ]);
    expect(await roles(`select role as r from team_members`)).toEqual([
      'agent-maintainer',
      'viewer',
    ]);
  });

  it('rewrites agent bindings', async () => {
    expect(await roles(`select role as r from agent_role_bindings`)).toEqual(['agent-maintainer']);
  });

  it('leaves no agent-engineer anywhere and refuses it from now on', async () => {
    expect(
      await roles(`select role as r from tenant_role_bindings where role = 'agent-engineer'`),
    ).toEqual([]);
    const ins = (role: string) =>
      c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role, source) values ($1, $2, $3, $4, 'grant')`,
        [randomUUID(), u.plain, root, role],
      );
    expect(await failure(ins('agent-engineer'))).toMatch(/trb_role_check|check/);
    await ins('agent-developer');
    await ins('agent-maintainer');
    expect(
      await failure(
        c.query(
          `insert into tenant_role_restrictions (tenant_id, role, permission) values ($1, 'agent-engineer', 'tokens:write')`,
          [child],
        ),
      ),
    ).toMatch(/trr_role_check|check/);
    await c.query(`delete from tenant_role_bindings where user_id = $1 and source = 'grant'`, [
      u.plain,
    ]);
  });

  it('the global_roles trigger keeps the renamed mirror rows and drops a removed one', async () => {
    const before = await bindingRoles(u.eng);
    await c.query(
      `update users set global_roles = '{agent-maintainer,viewer,auditor}' where id = $1`,
      [u.eng],
    );
    expect(await bindingRoles(u.eng)).toEqual(before);
    await c.query(`update users set global_roles = '{viewer}' where id = $1`, [u.eng]);
    expect(await bindingRoles(u.eng)).toEqual(['agent-maintainer|grant', 'viewer|mirror']);
    await c.query(`update users set global_roles = '{agent-maintainer,viewer}' where id = $1`, [
      u.eng,
    ]);
    await c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role) values ($1, $2, $3, 'agent-maintainer')`,
      [randomUUID(), u.eng, root],
    );
    expect(await bindingRoles(u.eng)).toEqual(before);
  });

  it('the down script refuses while agent-developer bindings exist and changes nothing', async () => {
    await c.query(
      `insert into team_members (team_id, user_id, role) values ($1, $2, 'agent-developer')`,
      [team, u.plain],
    );
    expect(await failure(c.script(DOWN))).toMatch(/agent-developer bindings exist/);
    expect(await roles(`select role as r from team_members`)).toContain('agent-maintainer');
    await c.query(`delete from team_members where role = 'agent-developer'`);
    await c.query(`update users set global_roles = '{agent-developer}' where id = $1`, [u.plain]);
    expect(await failure(c.script(DOWN))).toMatch(/agent-developer bindings exist/);
    await c.query(`update users set global_roles = '{operator}' where id = $1`, [u.plain]);
  });

  it('the down script maps agent-maintainer back to agent-engineer everywhere', async () => {
    await c.script(DOWN);
    expect(await globalRoles(u.eng)).toEqual(['agent-engineer', 'viewer']);
    expect(await bindingRoles(u.eng)).toEqual([
      'agent-engineer|grant',
      'agent-engineer|mirror',
      'viewer|mirror',
    ]);
    expect(await roles(`select role as r from team_members`)).toEqual(['agent-engineer', 'viewer']);
    expect(await roles(`select role as r from tenant_role_restrictions`)).toEqual([
      'agent-engineer',
    ]);
    expect(await roles(`select role as r from agent_role_bindings`)).toEqual(['agent-engineer']);
    const insert = (role: string) =>
      c.query(
        `insert into tenant_role_bindings (id, user_id, tenant_id, role, source) values ($1, $2, $3, $4, 'grant')`,
        [randomUUID(), u.plain, root, role],
      );
    expect(await failure(insert('agent-maintainer'))).toMatch(/trb_role_check|check/);
    await insert('agent-engineer');
  });
});
