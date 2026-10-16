import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0036 (ADR 0017 slice S2b, #343): `users.created_by`, the `grantor_unknown` marker on the
 * three binding tables, the attribution of old rows from the audit chain, the user-delete trigger and
 * the home-move trigger. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0036_grantor_unknown';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};

describe('migration 0036 files', () => {
  it('is strictly newer than 0034, chains its snapshot and has a down path', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at - 1]!.tag).toBe('0034_review_threads');
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0036').prevId).toBe(read('0034').id);
    expect(read('0036').tables['public.users'].columns.created_by).toBeDefined();
    for (const t of ['tenant_role_bindings', 'team_members', 'agent_role_bindings'])
      expect(read('0036').tables[`public.${t}`].columns.grantor_unknown.notNull).toBe(true);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0036 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const id = () => randomUUID();
  const boot = id();
  const admin = id();
  const attributed = id(); // role in global_roles put there by `admin` (audit shows it)
  const unattributed = id(); // local, nothing in the audit chain
  const idp = id(); // oidc account
  const readded = id(); // role removed and put back by somebody else
  const ghost = id();
  const team = id();
  const agent = id();
  let seq = 0;
  let epochBefore: unknown[] = [];
  const epochs = async () =>
    (await c.query(`select id, authz_epoch::text as e from tenants order by id`)).rows;
  const audit = (actor: string, action: string, target: string, payload: object) =>
    c.query(
      `insert into audit_log (seq, tenant_id, ts, actor, action, target, payload, payload_digest, prev_hash, hash)
       values ($1, $2, now(), $3, $4, $5, $6::jsonb, 'd', 'p', 'h')`,
      [++seq, root, actor, action, target, JSON.stringify(payload)],
    );
  const user = (userId: string, email: string, source: string, roles: string[] = []) =>
    c.query(
      `insert into users (id, email, display_name, source, global_roles, tenant_id) values ($1, $2, $2, $3, $4, $5)`,
      [userId, email, source, roles, root],
    );
  const mirror = (userId: string, role: string) =>
    c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit, source) values ($1, $2, $3, $4, false, 'mirror')`,
      [id(), userId, root, role],
    );
  const flag = async (table: string, where: string, args: unknown[]) =>
    (await c.query(`select granted_by, grantor_unknown from ${table} where ${where}`, args))
      .rows[0] as { granted_by: string | null; grantor_unknown: boolean };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    c = await open();
    await c.migrate(dir);
    await user(boot, 'boot@example.org', 'local', ['admin']);
    await user(admin, 'admin@example.org', 'local', ['admin']);
    await user(attributed, 'attributed@example.org', 'local', ['agent-maintainer']);
    await user(unattributed, 'unattributed@example.org', 'local', ['agent-maintainer']);
    await user(idp, 'idp@example.org', 'oidc', ['agent-maintainer']);
    await user(readded, 'readded@example.org', 'local', ['agent-maintainer']);
    await user(ghost, 'ghost@example.org', 'local');
    for (const [u, r] of [
      [boot, 'admin'],
      [admin, 'admin'],
      [attributed, 'agent-maintainer'],
      [unattributed, 'agent-maintainer'],
      [idp, 'agent-maintainer'],
      [readded, 'agent-maintainer'],
    ] as const)
      await mirror(u, r);
    // the audit chain: the bootstrap, who created whom and who listed which role
    await audit('system', 'user.bootstrap', 'boot@example.org', {});
    await audit(boot, 'user.created', admin, { globalRoles: ['admin'] });
    await audit(admin, 'user.created', attributed, { globalRoles: ['agent-maintainer'] });
    await audit(boot, 'user.created', readded, { globalRoles: ['agent-maintainer'] });
    await audit(boot, 'user.updated', readded, { globalRoles: [] });
    await audit(admin, 'user.updated', readded, { globalRoles: ['agent-maintainer'] });
    // a grant row whose grantor was deleted, a team and an agent membership
    await c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit, source) values ($1, $2, $3, 'viewer', false, 'grant')`,
      [id(), ghost, root],
    );
    await c.query(`insert into teams (id, tenant_id, slug, name) values ($1, $2, 't', 'T')`, [
      team,
      root,
    ]);
    await c.query(
      `insert into team_members (team_id, user_id, role) values ($1, $2, 'agent-maintainer'), ($1, $3, 'agent-maintainer'), ($1, $4, 'agent-maintainer')`,
      [team, attributed, unattributed, idp],
    );
    await audit(admin, 'team.members.set', team, {
      members: [{ userId: attributed, role: 'agent-maintainer' }],
    });
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'a', 'x')`,
      [agent, root],
    );
    await c.query(
      `insert into agent_role_bindings (user_id, agent_id, role) values ($1, $2, 'agent-maintainer'), ($3, $2, 'agent-maintainer')`,
      [attributed, agent, unattributed],
    );
    await audit(boot, 'agent.members.set', agent, {
      members: [{ userId: attributed, role: 'agent-maintainer' }],
    });
    epochBefore = await epochs();
    epochBefore = await epochs();
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attributes the creator of local accounts from the audit chain', async () => {
    const rows = (await c.query(`select id, created_by from users`)).rows as {
      id: string;
      created_by: string | null;
    }[];
    const by = new Map(rows.map((r) => [r.id, r.created_by]));
    expect(by.get(admin)).toBe(boot);
    expect(by.get(attributed)).toBe(admin);
    expect(by.get(unattributed)).toBeNull();
  });

  it('attributes mirror rows to whoever put the role into global_roles, after the last removal', async () => {
    const q = (u: string) =>
      flag('tenant_role_bindings', `user_id = $1 and source = 'mirror'`, [u]);
    expect(await q(attributed)).toEqual({ granted_by: admin, grantor_unknown: false });
    // removed by one administrator and put back by another: the second one made the binding
    expect(await q(readded)).toEqual({ granted_by: admin, grantor_unknown: false });
    expect(await q(admin)).toEqual({ granted_by: boot, grantor_unknown: false });
  });

  it('keeps "nobody" for the bootstrap administrator and identity-provider accounts', async () => {
    const q = (u: string) =>
      flag('tenant_role_bindings', `user_id = $1 and source = 'mirror'`, [u]);
    expect(await q(boot)).toEqual({ granted_by: null, grantor_unknown: false });
    expect(await q(idp)).toEqual({ granted_by: null, grantor_unknown: false });
  });

  it('marks what it cannot attribute as unknown instead of leaving a clean-looking row', async () => {
    expect(
      await flag('tenant_role_bindings', `user_id = $1 and source = 'mirror'`, [unattributed]),
    ).toEqual({ granted_by: null, grantor_unknown: true });
    expect(
      await flag('tenant_role_bindings', `user_id = $1 and source = 'grant'`, [ghost]),
    ).toEqual({ granted_by: null, grantor_unknown: true });
  });

  it('does the same for team and agent memberships', async () => {
    const t = (u: string) => flag('team_members', `team_id = $1 and user_id = $2`, [team, u]);
    expect(await t(attributed)).toEqual({ granted_by: admin, grantor_unknown: false });
    expect(await t(unattributed)).toEqual({ granted_by: null, grantor_unknown: true });
    expect(await t(idp)).toEqual({ granted_by: null, grantor_unknown: false });
    const a = (u: string) =>
      flag('agent_role_bindings', `agent_id = $1 and user_id = $2`, [agent, u]);
    expect(await a(attributed)).toEqual({ granted_by: boot, grantor_unknown: false });
    expect(await a(unattributed)).toEqual({ granted_by: null, grantor_unknown: true });
  });

  it('does not bump the authz epoch of any organisation while it attributes rows', async () => {
    expect(epochBefore.length).toBeGreaterThan(0);
    expect(await epochs()).toEqual(epochBefore);
  });

  it('marks the rows a deleted user granted as unknown instead of anonymous', async () => {
    await c.query(`delete from users where id = $1`, [admin]);
    expect(
      await flag('tenant_role_bindings', `user_id = $1 and source = 'mirror'`, [attributed]),
    ).toEqual({ granted_by: null, grantor_unknown: true });
    expect(await flag('team_members', `team_id = $1 and user_id = $2`, [team, attributed])).toEqual(
      { granted_by: null, grantor_unknown: true },
    );
    expect(
      (await c.query(`select created_by from users where id = $1`, [attributed])).rows,
    ).toEqual([{ created_by: null }]);
  });

  it('marks mirror rows that the home-move trigger creates as unknown', async () => {
    const other = id();
    await c.query(
      `insert into tenants (id, slug, name, parent_id, root_id, path, depth) values ($1, 'child', 'child', $2, $2, $3, 1)`,
      [other, root, `/${root}/${other}/`],
    );
    await c.query(`update users set tenant_id = $2 where id = $1`, [readded, other]);
    expect(
      await flag('tenant_role_bindings', `user_id = $1 and tenant_id = $2 and source = 'mirror'`, [
        readded,
        other,
      ]),
    ).toEqual({ granted_by: null, grantor_unknown: true });
  });
});
