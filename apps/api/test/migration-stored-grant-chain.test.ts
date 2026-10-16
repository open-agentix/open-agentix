import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { GRANTING_ROLES } from '../src/services/grant-chain.js';
import { sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0037 (#356): `grant_chain` on the three binding tables and on users, `users.creator_unknown`,
 * the strict re-check of what 0036 attributed from the audit chain (a chain that starts mid-way, a
 * role that was never absent, entries without `globalRoles`, a system actor), the backfill of the
 * chain, and the delete trigger. The data is set up as migration 0036 leaves it. Runs on PGlite and,
 * with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0037_stored_grant_chain';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};

describe('migration 0037 files', () => {
  it('walks the roles that may grant: the SQL names admin', () => {
    expect([...GRANTING_ROLES]).toEqual(['admin']);
  });

  it('is strictly newer than 0036, chains its snapshot, keeps the index contiguous and has a down path', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at - 1]!.tag).toBe('0036_grantor_unknown');
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0037').prevId).toBe(read('0036').id);
    for (const t of ['users', 'tenant_role_bindings', 'team_members', 'agent_role_bindings'])
      expect(read('0037').tables[`public.${t}`].columns.grant_chain.type).toBe('uuid[]');
    const unknown = read('0037').tables['public.users'].columns.creator_unknown;
    expect(unknown.notNull).toBe(true);
    expect(unknown.default).toBe(false);
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0037 on existing data (%s)', (_kind, enabled, open) => {
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
  const created = id(); // user.created lists the role
  const midway = id(); // the chain starts with a user.updated that lists the role
  const nokey = id(); // user.created / updated without globalRoles, then one that lists the role
  const readded = id(); // absent, then put back by somebody else
  const scripted = id(); // user.created by the actor "system"
  const idp = id(); // oidc, role listed by an administrator before
  const idpClean = id(); // oidc, never listed
  const madeBy = id(); // local account created by admin
  const lonely = id(); // local account nobody is shown to have made
  const cA = id(); // laundering: C grants D admin, D makes X an approver
  const dB = id();
  const xC = id();
  const ring = [id(), id(), id(), id(), id(), id(), id(), id()]; // each made by the one before: 8 hops
  const cyc1 = id(); // two accounts that created each other
  const cyc2 = id();
  const viaLonely = id();
  const team1 = id(); // team.created, then members.set
  const team2 = id(); // members.set is the first entry of the team
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
  const user = (userId: string, email: string, source: string, roles: string[] = [], by?: string) =>
    c.query(
      `insert into users (id, email, display_name, source, global_roles, tenant_id, created_by) values ($1, $2, $2, $3, $4, $5, $6)`,
      [userId, email, source, roles, root, by ?? null],
    );
  /** A mirror row as 0036 leaves it: `by` is what its attribution wrote. */
  const mirror = (userId: string, role: string, by: string | null, unknown = false) =>
    c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit, source, granted_by, grantor_unknown) values ($1, $2, $3, $4, false, 'mirror', $5, $6)`,
      [id(), userId, root, role, by, unknown],
    );
  const row = async (table: string, where: string, args: unknown[]) =>
    (
      await c.query(
        `select granted_by, grantor_unknown, grant_chain from ${table} where ${where}`,
        args,
      )
    ).rows
      .map(
        (r) =>
          r as {
            granted_by: string | null;
            grantor_unknown: boolean;
            grant_chain: string[] | null;
          },
      )
      .map((r) => ({ ...r, grant_chain: r.grant_chain && [...r.grant_chain].sort() }))[0]!;
  /** A chain as the database returns it, sorted. */
  const chain = (...ids: string[]) => [...ids].sort();
  const m = (u: string) => row('tenant_role_bindings', `user_id = $1 and source = 'mirror'`, [u]);
  const MAINT = 'agent-maintainer';

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
    await user(admin, 'admin@example.org', 'local', ['admin'], boot);
    await user(created, 'created@example.org', 'local', [MAINT], admin);
    await user(midway, 'midway@example.org', 'local', [MAINT], admin);
    await user(nokey, 'nokey@example.org', 'local', [MAINT], admin);
    await user(readded, 'readded@example.org', 'local', [MAINT], admin);
    await user(scripted, 'scripted@example.org', 'local', [MAINT]);
    await user(idp, 'idp@example.org', 'oidc', [MAINT]);
    await user(idpClean, 'idpclean@example.org', 'oidc', [MAINT]);
    await user(madeBy, 'madeby@example.org', 'local', [], admin);
    await user(lonely, 'lonely@example.org', 'local');
    await audit('system', 'user.bootstrap', 'boot@example.org', {});
    // rows made BEFORE the migration: C (made by the bootstrap administrator) grants D admin, D makes X
    await user(cA, 'ca@example.org', 'local', ['admin'], boot);
    await user(dB, 'db@example.org', 'local', [], cA);
    await user(xC, 'xc@example.org', 'local', [], dB);
    await c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit, source, granted_by) values ($1, $2, $3, 'admin', false, 'grant', $4), ($5, $6, $3, 'agent-maintainer', false, 'grant', $2)`,
      [id(), dB, root, cA, id(), xC],
    );
    // a chain of 8 accounts, each made by the one before, and a ring
    for (let i = 0; i < ring.length; i++)
      await user(ring[i]!, `ring${i}@example.org`, 'local', [], i === 0 ? boot : ring[i - 1]);
    await c.query(
      `insert into tenant_role_bindings (id, user_id, tenant_id, role, inherit, source, granted_by) values ($1, $2, $3, 'viewer', false, 'grant', $4)`,
      [id(), admin, root, ring[7]],
    );
    await c.query(
      `insert into users (id, email, display_name, source, tenant_id) values ($1, 'cyc1@example.org', 'c', 'local', $3), ($2, 'cyc2@example.org', 'c', 'local', $3)`,
      [cyc1, cyc2, root],
    );
    await c.query(`update users set created_by = $2 where id = $1`, [cyc1, cyc2]);
    await c.query(`update users set created_by = $2 where id = $1`, [cyc2, cyc1]);
    await user(viaLonely, 'vl@example.org', 'local', [], lonely);
    // mirror rows as 0036 attributed them
    await mirror(boot, 'admin', null);
    await mirror(admin, 'admin', boot);
    await mirror(created, MAINT, admin);
    await mirror(midway, MAINT, admin); // 0036 took the first entry it saw
    await mirror(nokey, MAINT, admin);
    await mirror(readded, MAINT, admin);
    await mirror(scripted, MAINT, null, true);
    await mirror(idp, MAINT, null);
    await mirror(idpClean, MAINT, null);
    await audit(boot, 'user.created', admin, { globalRoles: ['admin'] });
    await audit(admin, 'user.created', created, { globalRoles: [MAINT] });
    // the chain of `midway` starts mid-way: the first entry already lists the role
    await audit(admin, 'user.updated', midway, { globalRoles: [MAINT] });
    // `nokey`: neither entry before the listing says anything about roles
    await audit(boot, 'user.created', nokey, { email: 'nokey@example.org' });
    await audit(boot, 'user.updated', nokey, { displayName: 'N' });
    await audit(admin, 'user.updated', nokey, { globalRoles: [MAINT] });
    // `readded`: created with the role, removed, put back by the administrator
    await audit(boot, 'user.created', readded, { globalRoles: [MAINT] });
    await audit(boot, 'user.updated', readded, { globalRoles: [] });
    await audit(admin, 'user.updated', readded, { globalRoles: [MAINT] });
    await audit('system', 'user.created', scripted, { globalRoles: [MAINT] });
    await audit(admin, 'user.updated', idp, { globalRoles: [MAINT] });
    // memberships
    await c.query(
      `insert into teams (id, tenant_id, slug, name) values ($1, $3, 't1', 'T1'), ($2, $3, 't2', 'T2')`,
      [team1, team2, root],
    );
    await c.query(
      `insert into team_members (team_id, user_id, role, granted_by) values ($1, $3, $5, $4), ($1, $6, $5, null), ($1, $7, $5, null), ($2, $3, $5, $4)`,
      [team1, team2, created, admin, MAINT, idp, idpClean],
    );
    await audit(admin, 'team.created', team1, {});
    await audit(admin, 'team.members.set', team1, { members: [{ userId: created, role: MAINT }] });
    await audit(admin, 'team.members.set', team1, {
      members: [
        { userId: created, role: MAINT },
        { userId: idp, role: MAINT },
      ],
    });
    // team2: its first entry already lists the member (nothing shows the team empty before)
    await audit(admin, 'team.members.set', team2, { members: [{ userId: created, role: MAINT }] });
    await c.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'a', 'x')`,
      [agent, root],
    );
    await c.query(
      `insert into agent_role_bindings (user_id, agent_id, role, granted_by) values ($1, $2, $3, $4)`,
      [created, agent, MAINT, boot],
    );
    await audit(boot, 'agent.created', agent, {});
    await audit(boot, 'agent.members.set', agent, { members: [{ userId: created, role: MAINT }] });
    epochBefore = await epochs();
    j.entries = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ).entries;
    writeFileSync(journalPath, JSON.stringify(j));
    await c.migrate(dir);
  }, 120_000);
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an attribution the audit chain can prove, and stores the transitive chain of the grantor', async () => {
    expect(await m(created)).toEqual({
      granted_by: admin,
      grantor_unknown: false,
      grant_chain: chain(admin, boot),
    });
    // removed and put back by somebody else: the second one made the binding
    expect(await m(readded)).toEqual({
      granted_by: admin,
      grantor_unknown: false,
      grant_chain: chain(admin, boot),
    });
    expect(await m(admin)).toEqual({
      granted_by: boot,
      grantor_unknown: false,
      grant_chain: chain(boot),
    });
  });

  it('turns an attribution into unknown, keeping granted_by, when the chain starts mid-way or shows the role never absent', async () => {
    expect(await m(midway)).toEqual({
      granted_by: admin,
      grantor_unknown: true,
      grant_chain: null,
    });
  });

  it('does not take entries without globalRoles as evidence that the role was absent', async () => {
    expect(await m(nokey)).toEqual({ granted_by: admin, grantor_unknown: true, grant_chain: null });
  });

  it('keeps a system actor unknown and nobody for the bootstrap administrator and untouched identity-provider accounts', async () => {
    expect(await m(scripted)).toEqual({
      granted_by: null,
      grantor_unknown: true,
      grant_chain: null,
    });
    expect(await m(boot)).toEqual({ granted_by: null, grantor_unknown: false, grant_chain: null });
    expect(await m(idpClean)).toEqual({
      granted_by: null,
      grantor_unknown: false,
      grant_chain: null,
    });
  });

  it('is no longer nobody for an identity-provider role or membership an administrator listed before', async () => {
    expect((await m(idp)).grantor_unknown).toBe(true);
    const t = (team: string, u: string) =>
      row('team_members', `team_id = $1 and user_id = $2`, [team, u]);
    expect((await t(team1, idp)).grantor_unknown).toBe(true);
    expect((await t(team1, idpClean)).grantor_unknown).toBe(false);
  });

  it('checks memberships the same way: the chain must show the member absent before', async () => {
    const t = (team: string) =>
      row('team_members', `team_id = $1 and user_id = $2`, [team, created]);
    // team1 has team.created before the listing: proved
    expect(await t(team1)).toEqual({
      granted_by: admin,
      grantor_unknown: false,
      grant_chain: chain(admin, boot),
    });
    // team2: the first entry of the team already lists the member
    expect(await t(team2)).toEqual({ granted_by: admin, grantor_unknown: true, grant_chain: null });
    const a = await row('agent_role_bindings', `agent_id = $1 and user_id = $2`, [agent, created]);
    expect(a).toEqual({ granted_by: boot, grantor_unknown: false, grant_chain: chain(boot) });
  });

  const u = async (userId: string) =>
    (
      await c.query(`select created_by, grant_chain, creator_unknown from users where id = $1`, [
        userId,
      ])
    ).rows.map((r) => {
      const x = r as {
        created_by: string | null;
        grant_chain: string[] | null;
        creator_unknown: boolean;
      };
      return { ...x, grant_chain: x.grant_chain && [...x.grant_chain].sort() };
    })[0]!;

  it('records the creator chain of local accounts and marks the ones nobody is shown to have made', async () => {
    expect(await u(madeBy)).toEqual({
      created_by: admin,
      grant_chain: chain(admin, boot),
      creator_unknown: false,
    });
    expect((await u(lonely)).creator_unknown).toBe(true);
    expect((await u(scripted)).creator_unknown).toBe(true);
    expect((await u(boot)).creator_unknown).toBe(false); // the bootstrap administrator
    expect((await u(idp)).creator_unknown).toBe(false); // identity-provider accounts have no local creator
  });

  it('does not bump the authz epoch of any organisation', async () => {
    expect(epochBefore.length).toBeGreaterThan(0);
    expect(await epochs()).toEqual(epochBefore);
  });

  it('backfills the chain transitively, so a link revoked after the upgrade cannot launder a row made before it', async () => {
    // C granted D admin, D granted X the role: X's chain reaches C and D from the start
    const x = () => row('tenant_role_bindings', `user_id = $1 and role = 'agent-maintainer'`, [xC]);
    expect(await x()).toEqual({
      granted_by: dB,
      grantor_unknown: false,
      grant_chain: chain(dB, cA, boot),
    });
    expect((await u(xC)).grant_chain).toEqual(chain(dB, cA, boot));
    // C (or anybody) revokes D's administrator binding AFTER the migration: the stored chain stays
    await c.query(`delete from tenant_role_bindings where user_id = $1 and role = 'admin'`, [dB]);
    expect((await x()).grant_chain).toEqual(chain(dB, cA, boot));
  });

  it('leaves a chain deeper than six hops, one through an unknown creator, and none for a ring that is walked once', async () => {
    // 8 accounts made one after the other: the walk overflows, the row is unknown
    const deep = await row('tenant_role_bindings', `user_id = $1 and role = 'viewer'`, [admin]);
    expect(deep).toEqual({ granted_by: ring[7], grantor_unknown: false, grant_chain: null });
    // an account made by an account whose creator is unknown
    const via = await u(viaLonely);
    expect(via.grant_chain).toBeNull();
    expect(via.creator_unknown).toBe(true);
    // two accounts that created each other: finished, and both in the chain
    expect((await u(cyc1)).grant_chain).toEqual(chain(cyc1, cyc2));
  });

  it('keeps what a deleted user granted attributable through the chain, and marks rows without one', async () => {
    // a row written without a chain (an old replica): the delete marks it
    await c.query(`update tenant_role_bindings set grant_chain = null where user_id = $1`, [
      readded,
    ]);
    await c.query(`delete from users where id = $1`, [admin]);
    expect(await m(created)).toEqual({
      granted_by: null,
      grantor_unknown: false,
      grant_chain: chain(admin, boot),
    });
    expect(await m(readded)).toEqual({
      granted_by: null,
      grantor_unknown: true,
      grant_chain: null,
    });
    expect(await u(madeBy)).toEqual({
      created_by: null,
      creator_unknown: false,
      grant_chain: chain(admin, boot),
    });
    // an account whose creator had no stored chain becomes unknown when the creator goes
    const orphan = id();
    const maker = id();
    await user(maker, 'maker@example.org', 'local');
    await user(orphan, 'orphan@example.org', 'local', [], maker);
    await c.query(`delete from users where id = $1`, [maker]);
    expect((await u(orphan)).creator_unknown).toBe(true);
  });
});
