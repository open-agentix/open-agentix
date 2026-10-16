import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { sqlTargets } from './db-targets.js';
import { buildWorld, PW, type World } from './use-case-world.js';

/**
 * Review of ADR 0014 S8 (#321): on the default (legacy) read path a team-scoped administrator
 * must not mint node-wide roles, accounts or teams. The read path is forced to `legacy` here, whatever
 * `OAX_TEST_ROLE_BINDINGS_READ` says.
 */
describe.each(sqlTargets)(
  'node-level authority on the legacy read path (%s)',
  (_kind, enabled, open) => {
    if (!enabled()) {
      it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
      return;
    }
    let w: World;
    let teamId: string;
    const userCount = async () => (await w.n.ctx.db.select().from(users)).length;

    beforeAll(async () => {
      w = await buildWorld(await open(), { OAX_ROLE_BINDINGS_READ: 'legacy' });
      expect(w.n.ctx.config.auth.roleBindingsRead).toBe('legacy');
      const team = await w.req(null, 'POST', '/v1/teams', { slug: 'blue', name: 'Blue' }, 'org-a');
      expect(team.statusCode, team.body).toBe(201);
      teamId = team.json().id;
      await w.mkUser('team-admin', 'org-a');
      await w.mkUser('node-admin', 'org-a', ['admin']);
      const put = await w.req(
        null,
        'PUT',
        `/v1/teams/${teamId}/members`,
        { members: [{ userId: w.uid['team-admin'], role: 'admin' }] },
        'org-a',
      );
      expect(put.statusCode, put.body).toBe(204);
      await w.relogin('team-admin');
    }, 240_000);
    afterAll(async () => w?.close());

    it('refuses a team admin account creation, role changes, team writes and member grants', async () => {
      const before = await userCount();
      const create = await w.req('team-admin', 'POST', '/v1/users', {
        email: 'minted@example.org',
        displayName: 'M',
        password: PW,
        globalRoles: ['admin'],
      });
      expect(create.statusCode).toBe(403);
      expect(await userCount()).toBe(before);
      const patch = await w.req('team-admin', 'PATCH', `/v1/users/${w.uid['grantee']}`, {
        globalRoles: ['admin'],
      });
      expect(patch.statusCode).toBe(403);
      expect((await w.n.services.identity.getUser(w.uid['grantee']!)).globalRoles).toEqual([]);
      const members = await w.req('team-admin', 'PUT', `/v1/teams/${teamId}/members`, {
        members: [{ userId: w.uid['grantee'], role: 'admin' }],
      });
      expect(members.statusCode).toBe(403);
      // updateTeam, createTeam and deleteTeam are node-level too
      expect(
        (await w.req('team-admin', 'PATCH', `/v1/teams/${teamId}`, { name: 'Renamed' })).statusCode,
      ).toBe(403);
      expect(
        (await w.req('team-admin', 'POST', '/v1/teams', { slug: 'red', name: 'R' })).statusCode,
      ).toBe(403);
      expect((await w.req('team-admin', 'DELETE', `/v1/teams/${teamId}`)).statusCode).toBe(403);
    });

    it('still lets an administrator with a global role do all of it', async () => {
      const r = await w.req('node-admin', 'POST', '/v1/users', {
        email: 'legit@example.org',
        displayName: 'L',
        password: PW,
        globalRoles: ['viewer'],
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(
        (await w.req('node-admin', 'PATCH', `/v1/teams/${teamId}`, { name: 'Renamed' })).statusCode,
      ).toBe(200);
    });
  },
);
