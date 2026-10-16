import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@openagentix/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  auditLog,
  teamMembers,
  tenantRoleBindings,
  tenants,
  users as usersTable,
} from '../src/db/schema.js';
import { currentAuthzEpoch } from '../src/services/role-bindings.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S10 (#195) with W13-11: moving a tenant and its subtree inside an organisation.
 * The whole stack: who may move, 404 parity, structure refusals, the effect on cached principals,
 * role restrictions, use-case attachments, the dry run (and what it hides), audit, atomicity and
 * concurrency, the legacy read path. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real
 * PostgreSQL. The move invariants over random trees are in tenant-move-property.test.ts.
 *
 *   org-a ─┬─ div-1 ─┬─ team-1 ── sub-1
 *          │         └─ team-2
 *          ├─ div-2 ── leaf-2
 *          └─ div-3
 *   org-b ─── x-unit
 */
const PW = 'long-password-123';
type Mode = 'legacy' | 'bindings';

describe.each(sqlTargets)('tenant moves (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  const id = {} as Record<string, string>;
  const tok = {} as Record<string, string>;
  const uid = {} as Record<string, string>;
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });
  const setMode = (m: Mode) => {
    (n.ctx.config.auth as unknown as { roleBindingsRead: Mode }).roleBindingsRead = m;
  };
  const bind = (
    user: string,
    tenant: string,
    role: Role,
    inherit: boolean,
    useCase: string | null = null,
  ) =>
    n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit,
      useCase,
      source: 'grant',
    });
  const mkUser = async (key: string, home: string, roles: Role[] = []) => {
    const email = `${key}@example.org`;
    const u = await n.services.identity.createLocalUser(
      { userId: op().userId, tenantId: id[home]! },
      { email, displayName: key, password: PW, globalRoles: roles },
    );
    uid[key] = u.id;
    tok[key] = await n.login(email, PW);
  };
  const move = (who: string | null, node: string, parent: string, dryRun = false) =>
    n.req({
      method: 'POST',
      url: `/v1/tenants/${id[node] ?? node}/move`,
      payload: { parentId: id[parent] ?? parent, dryRun },
      ...(who === null ? {} : { token: tok[who]! }),
    });
  const row = async (slug: string) =>
    (await n.ctx.db.select().from(tenants).where(eq(tenants.id, id[slug]!)))[0]!;
  const epoch = (slug: string) => currentAuthzEpoch(n.ctx.db, id[slug]!);
  const visibleIds = async (who: string) =>
    new Set(
      (
        (await n.req({ method: 'GET', url: '/v1/tenants', token: tok[who]! })).json() as {
          items: { id: string }[];
        }
      ).items.map((t) => t.id),
    );
  const audit = async (action: string, tenant: string) =>
    (
      await n.ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, action))
        .orderBy(asc(auditLog.seq))
    ).filter((e) => e.tenantId === id[tenant]);
  /** Moves a node back below `parent` as an operator and checks the tree stayed consistent. */
  const restore = async (node: string, parent: string) => {
    if ((await row(node)).parentId !== id[parent]) {
      const r = await move('platform', node, parent);
      expect(r.statusCode, r.body).toBe(200);
    }
  };
  const consistent = async () => {
    const rows = await n.ctx.db.select().from(tenants);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (r.parentId === null) {
        expect(r.path).toBe(`/${r.id}/`);
        continue;
      }
      const p = byId.get(r.parentId)!;
      expect(r.path).toBe(`${p.path}${r.id}/`);
      expect(r.depth).toBe(p.depth + 1);
      expect(r.rootId).toBe(p.rootId);
    }
  };

  beforeAll(async () => {
    target = await open();
    n = await testNode({
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '100000',
      OAX_RATE_LIMIT_RESTRICTION_MAX: '100000',
      OAX_BINDING_REAPER_INTERVAL_SECONDS: '0',
    });
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
    const child = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await child('org-a', 'div-1');
    await child('div-1', 'team-1');
    await child('team-1', 'sub-1');
    await child('div-1', 'team-2');
    await child('org-a', 'div-2');
    await child('div-2', 'leaf-2');
    await child('org-a', 'div-3');
    await child('org-b', 'x-unit');
    await mkUser('root-admin', 'org-a');
    await bind('root-admin', 'org-a', 'admin', true);
    await mkUser('admin-d1', 'div-1');
    await bind('admin-d1', 'div-1', 'admin', true);
    await mkUser('admin-d12', 'div-1');
    await bind('admin-d12', 'div-1', 'admin', true);
    await bind('admin-d12', 'div-2', 'admin', true);
    await mkUser('direct-d2', 'div-1');
    await bind('direct-d2', 'div-1', 'admin', true);
    await bind('direct-d2', 'div-2', 'admin', false); // administers div-2 but does not inherit
    await mkUser('uc-admin', 'org-a');
    await bind('uc-admin', 'div-1', 'admin', true, 'security');
    await bind('uc-admin', 'div-2', 'admin', true, 'security');
    await mkUser('viewer-d2', 'div-2');
    await bind('viewer-d2', 'div-2', 'viewer', true);
    await mkUser('viewer-d1', 'div-1');
    await bind('viewer-d1', 'div-1', 'viewer', true);
    await mkUser('viewer-org', 'org-a');
    await bind('viewer-org', 'org-a', 'viewer', true);
    await mkUser('admin-b', 'org-b');
    await bind('admin-b', 'org-b', 'admin', true);
    await mkUser('platform', 'org-a', ['admin']);
    await n.ctx.db
      .update(usersTable)
      .set({ platformAdmin: true })
      .where(eq(usersTable.id, uid.platform!));
    tok.platform = await n.login('platform@example.org', PW);
  }, 180_000);
  // A failed assertion must not leave a moved tree behind for the next test.
  afterEach(async () => {
    for (const [node, parent] of [
      ['team-1', 'div-1'],
      ['team-2', 'div-1'],
      ['sub-1', 'team-1'],
    ] as const)
      await restore(node, parent);
  });
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('authority', () => {
    it('needs an inheriting admin covering the node, the old parent and the new parent', async () => {
      // admin-d1 covers team-1 and div-1 but not div-2: div-2 is not even visible, so 404
      const hidden = await move('admin-d1', 'team-1', 'div-2');
      expect(hidden.statusCode).toBe(404);
      // the same answer as for an id that does not exist
      const unknown = await move('admin-d1', 'team-1', randomUUID());
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual(hidden.json());
      // a node the caller cannot see: the same
      const node = await move('admin-d1', 'leaf-2', 'div-1');
      expect(node.statusCode).toBe(404);
      expect(node.json()).toEqual((await move('admin-d1', randomUUID(), 'div-1')).json());
      expect((await row('team-1')).parentId).toBe(id['div-1']);
    });

    it('a direct admin of the new parent, a use-case admin and a viewer are refused', async () => {
      const direct = await move('direct-d2', 'team-1', 'div-2');
      expect(direct.statusCode).toBe(403);
      expect(direct.json().error).toBe('inheritance_required');
      // a use-case administrator holds nothing node-wide: the node is not even visible
      expect([403, 404]).toContain((await move('uc-admin', 'team-1', 'div-2')).statusCode);
      // a viewer sees the nodes but holds no admin
      expect((await move('viewer-org', 'team-1', 'div-2')).statusCode).toBe(403);
      expect((await move('viewer-d1', 'team-1', 'div-1')).statusCode).toBe(403);
      expect((await row('team-1')).parentId).toBe(id['div-1']);
    });

    it('admin of the old parent only: the node must be covered as well', async () => {
      // admin-d12 covers both divisions; moving div-3 (covered by nobody but root-admin) is 404
      expect((await move('admin-d12', 'div-3', 'div-2')).statusCode).toBe(404);
    });

    it('moves for an inheriting admin of all three nodes, and the mover gains no coverage', async () => {
      const before = await epoch('org-a');
      const r = await move('admin-d12', 'team-1', 'div-2');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        dryRun: false,
        nodeId: id['team-1'],
        fromParentId: id['div-1'],
        toParentId: id['div-2'],
        nodes: 2,
        depthChange: 0,
        slugPath: { from: 'org-a/div-1/team-1', to: 'org-a/div-2/team-1' },
        principals: [],
      });
      expect(await epoch('org-a')).toBeGreaterThan(before!);
      const team = await row('team-1');
      expect(team.parentId).toBe(id['div-2']);
      expect(team.path).toBe(`${(await row('div-2')).path}${id['team-1']}/`);
      expect((await row('sub-1')).path).toBe(`${team.path}${id['sub-1']}/`);
      await consistent();
      // the mover still reaches exactly what it administers: everything below div-1 and div-2
      const seen = await visibleIds('admin-d12');
      for (const s of ['div-1', 'div-2', 'team-1', 'sub-1', 'team-2', 'leaf-2'])
        expect(seen.has(id[s]!), s).toBe(true);
      for (const s of ['org-a', 'div-3', 'org-b']) expect(seen.has(id[s]!), s).toBe(false);
      await restore('team-1', 'div-1');
    });
  });

  describe('the effect on access', () => {
    it('cached principals follow the move: inherited access stops and starts', async () => {
      // warm the caches
      const d1 = await visibleIds('viewer-d1');
      const d2 = await visibleIds('viewer-d2');
      expect(d1.has(id['team-1']!)).toBe(true);
      expect(d2.has(id['team-1']!)).toBe(false);
      expect((await move('root-admin', 'team-1', 'div-2')).statusCode).toBe(200);
      expect((await visibleIds('viewer-d1')).has(id['team-1']!)).toBe(false);
      expect((await visibleIds('viewer-d1')).has(id['sub-1']!)).toBe(false);
      expect((await visibleIds('viewer-d2')).has(id['team-1']!)).toBe(true);
      expect((await visibleIds('viewer-d2')).has(id['sub-1']!)).toBe(true);
      // the organisation-wide viewer is unaffected
      expect((await visibleIds('viewer-org')).has(id['sub-1']!)).toBe(true);
      // a moved node is visible by its new slug path only
      const get = await n.req({
        method: 'GET',
        url: `/v1/tenants/${id['team-1']}`,
        token: tok['root-admin']!,
      });
      expect(get.json().slugPath).toBe('org-a/div-2/team-1');
      await restore('team-1', 'div-1');
      expect((await visibleIds('viewer-d1')).has(id['sub-1']!)).toBe(true);
      expect((await visibleIds('viewer-d2')).has(id['sub-1']!)).toBe(false);
    });

    it('bindings on moved nodes move with them', async () => {
      await mkUser('team-viewer', 'team-1');
      await bind('team-viewer', 'team-1', 'viewer', true);
      expect((await visibleIds('team-viewer')).has(id['sub-1']!)).toBe(true);
      expect((await move('root-admin', 'team-1', 'div-3')).statusCode).toBe(200);
      expect((await visibleIds('team-viewer')).has(id['sub-1']!)).toBe(true);
      expect((await visibleIds('team-viewer')).has(id['div-1']!)).toBe(false);
      await restore('team-1', 'div-1');
    });
  });

  describe('structure', () => {
    it('refuses a cycle, the current parent, a root and another organisation', async () => {
      const own = await move('root-admin', 'div-1', 'div-1');
      expect(own.statusCode).toBe(422);
      expect(own.json().error).toBe('move_cycle');
      expect((await move('root-admin', 'div-1', 'sub-1')).json().error).toBe('move_cycle');
      const noop = await move('root-admin', 'team-1', 'div-1');
      expect(noop.statusCode).toBe(409);
      expect(noop.json().error).toBe('move_noop');
      const root = await move('root-admin', 'org-a', 'div-1');
      expect(root.statusCode).toBe(403);
      expect(root.json().error).toBe('move_not_allowed');
      expect((await move('platform', 'org-a', 'div-1')).json().error).toBe('move_not_supported');
      // another organisation: invisible to an organisation admin, unsupported for an operator
      expect((await move('root-admin', 'team-1', 'x-unit')).statusCode).toBe(404);
      expect((await move('root-admin', 'x-unit', 'div-1')).statusCode).toBe(404);
      const cross = await move('platform', 'team-1', 'x-unit');
      expect(cross.statusCode).toBe(422);
      expect(cross.json().error).toBe('move_not_supported');
      await consistent();
    });

    it('re-checks the depth limit for the deepest moved node', async () => {
      const cfg = n.ctx.config.tenancy as unknown as { maxDepth: number };
      const was = cfg.maxDepth;
      try {
        cfg.maxDepth = 3; // div-1 -> team-1 -> sub-1 is depth 3; below leaf-2 it would be 4
        const r = await move('root-admin', 'team-1', 'leaf-2');
        expect(r.statusCode).toBe(422);
        expect(r.json().error).toBe('tenant_depth_exceeded');
        cfg.maxDepth = 4;
        expect((await move('root-admin', 'team-1', 'leaf-2')).statusCode).toBe(200);
        expect((await row('sub-1')).depth).toBe(4);
      } finally {
        cfg.maxDepth = was;
      }
      await restore('team-1', 'div-1');
      expect((await row('sub-1')).depth).toBe(3);
    });

    it('a tenant admin cannot move below a node with a budget; an operator can', async () => {
      await n.ctx.db
        .update(tenants)
        .set({ monthlyBudgetMicros: 5_000_000 })
        .where(eq(tenants.id, id['div-2']!));
      const r = await move('root-admin', 'team-1', 'div-2');
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('budget_capped');
      expect((await move('platform', 'team-1', 'div-2')).statusCode).toBe(200);
      await n.ctx.db
        .update(tenants)
        .set({ monthlyBudgetMicros: null })
        .where(eq(tenants.id, id['div-2']!));
      await restore('team-1', 'div-1');
    });

    it('the legacy read path refuses', async () => {
      setMode('legacy');
      try {
        const r = await move('platform', 'team-1', 'div-2');
        expect(r.statusCode).toBe(409);
        expect(r.json().error).toBe('role_bindings_read_required');
      } finally {
        setMode('bindings');
      }
      expect((await row('team-1')).parentId).toBe(id['div-1']);
    });
  });

  describe('restrictions and use cases', () => {
    it('leaving a restriction needs the authority to lift it; entering one only narrows', async () => {
      await mkUser('sub-viewer', 'sub-1');
      await bind('sub-viewer', 'sub-1', 'viewer', false);
      // a restriction at div-1 narrows the viewer bound inside team-1
      const put = await n.req({
        method: 'PUT',
        url: `/v1/tenants/${id['div-1']}/role-restrictions`,
        payload: { role: 'viewer', permissions: ['costs:read'] },
        token: tok['root-admin']!,
      });
      expect(put.statusCode, put.body).toBe(200);
      // a node administrator of sub-1, div-2 and its old parent team-1, but not of div-1
      await mkUser('inner-admin', 'sub-1');
      await bind('inner-admin', 'team-1', 'admin', true);
      await bind('inner-admin', 'div-2', 'admin', true);
      const refused = await move('inner-admin', 'sub-1', 'div-2');
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toBe('restriction_removal_forbidden');
      // the dry run runs the same checks
      expect((await move('inner-admin', 'sub-1', 'div-2', true)).statusCode).toBe(403);
      // an administrator of div-1 may
      const dry = await move('admin-d12', 'sub-1', 'div-2', true);
      expect(dry.statusCode, dry.body).toBe(200);
      expect(dry.json().restrictionsDropped).toEqual([
        { nodeId: id['div-1'], role: 'viewer', permissions: ['costs:read'] },
      ]);
      // the viewer bound inside regains costs:read after the move: listed
      expect(
        dry.json().principals.find((x: { userId: string }) => x.userId === uid['sub-viewer']),
      ).toMatchObject({ permissionsGained: ['costs:read'], permissionsLost: [] });
      expect((await move('admin-d12', 'sub-1', 'div-2')).statusCode).toBe(200);
      // moving under a restriction narrows: back below div-1 the permission is gone again
      const back = await move('root-admin', 'sub-1', 'team-1', true);
      expect(
        back.json().principals.find((x: { userId: string }) => x.userId === uid['sub-viewer']),
      ).toMatchObject({ permissionsLost: ['costs:read'], permissionsGained: [] });
      expect(back.json().restrictionsApplied).toEqual([
        { nodeId: id['div-1'], role: 'viewer', permissions: ['costs:read'] },
      ]);
      await restore('sub-1', 'team-1');
      await n.req({
        method: 'DELETE',
        url: `/v1/tenants/${id['div-1']}/role-restrictions?role=viewer`,
        token: tok['root-admin']!,
      });
    });

    it('refuses to leave a restriction for a role nobody holds inside yet', async () => {
      await mkUser('np-admin', 'sub-1');
      await bind('np-admin', 'team-1', 'admin', true);
      await bind('np-admin', 'div-2', 'admin', true);
      const put = await n.req({
        method: 'PUT',
        url: `/v1/tenants/${id['div-1']}/role-restrictions`,
        payload: { role: 'integrator', permissions: ['connections:write'] },
        token: tok['root-admin']!,
      });
      expect(put.statusCode, put.body).toBe(200);
      try {
        // no integrator is bound inside sub-1, but one could be granted there tomorrow
        const r = await move('np-admin', 'sub-1', 'div-2');
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json().error).toBe('restriction_removal_forbidden');
        expect((await row('sub-1')).parentId).toBe(id['team-1']);
        // an operator moves, and the dry run reports nothing that matters today
        const dry = await move('platform', 'sub-1', 'div-2', true);
        expect(dry.json().restrictionsDropped).toEqual([]);
      } finally {
        await n.req({
          method: 'DELETE',
          url: `/v1/tenants/${id['div-1']}/role-restrictions?role=integrator`,
          token: tok['root-admin']!,
        });
      }
    });

    it('refuses to loosen the agent lifecycle policy of the subtree, and says which keys', async () => {
      const set = (v: number | null) =>
        n.req({
          method: 'PATCH',
          url: `/v1/tenants/${id['div-1']}/settings/agent-lifecycle`,
          payload: { minApprovals: v },
          token: tok['root-admin']!,
        });
      expect((await set(3)).statusCode).toBe(200);
      try {
        // np-admin administers sub-1's old parent and the new parent, but not div-1 which sets it
        const refused = await move('np-admin', 'sub-1', 'div-2');
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json().error).toBe('policy_widening_forbidden');
        expect((await move('np-admin', 'sub-1', 'div-2', true)).statusCode).toBe(403);
        // an administrator of div-1 sees the keys in the dry run and may move
        const dry = await move('root-admin', 'sub-1', 'div-2', true);
        expect(dry.json().policiesWidened).toEqual(['minApprovals']);
        const moves = (await audit('tenant.moved', 'sub-1')).length;
        expect((await move('root-admin', 'sub-1', 'div-2')).statusCode).toBe(200);
        expect((await audit('tenant.moved', 'sub-1')).at(-1)?.payload).toMatchObject({
          policiesWidened: 1,
        });
        expect((await audit('tenant.moved', 'sub-1')).length).toBe(moves + 1);
        // moving between nodes under the same policy loosens nothing
        const same = await move('root-admin', 'team-2', 'team-1', true);
        expect(same.json().policiesWidened).toEqual([]);
      } finally {
        await set(null);
      }
    });

    it('needs authority over the old parent too', async () => {
      await mkUser('node-admin', 'sub-1');
      await bind('node-admin', 'sub-1', 'admin', true);
      await bind('node-admin', 'div-2', 'admin', true);
      // inheriting admin of the node and of the new parent, but not of its old parent team-1
      const r = await move('node-admin', 'sub-1', 'div-2');
      expect(r.statusCode, r.body).toBe(403);
      expect((await row('sub-1')).parentId).toBe(id['team-1']);
    });

    it('detaches the node from its use case and audits it', async () => {
      await mkUser('sec-admin', 'div-1');
      await bind('sec-admin', 'div-1', 'admin', true, 'security');
      await mkUser('sec-admin2', 'div-2');
      await bind('sec-admin2', 'div-2', 'admin', true, 'security');
      const attach = await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${id['team-2']}`,
        payload: { useCase: 'security' },
        token: tok['root-admin']!,
      });
      expect(attach.statusCode, attach.body).toBe(200);
      // the use-case administrator of div-1 reaches the attached node
      expect((await visibleIds('sec-admin')).has(id['team-2']!)).toBe(true);
      expect((await visibleIds('sec-admin2')).has(id['team-2']!)).toBe(false);
      const dry = await move('root-admin', 'team-2', 'div-2', true);
      expect(dry.json().detachesUseCase).toBe('security');
      expect((await row('team-2')).useCase).toBe('security'); // a dry run changes nothing
      expect((await move('root-admin', 'team-2', 'div-2')).statusCode).toBe(200);
      expect((await row('team-2')).useCase).toBeNull();
      // the same-named use case of the new parent does not pick the node up
      expect((await visibleIds('sec-admin2')).has(id['team-2']!)).toBe(false);
      expect((await visibleIds('sec-admin')).has(id['team-2']!)).toBe(false);
      const detached = await audit('tenant.detached', 'team-2');
      expect(detached.at(-1)?.payload).toMatchObject({
        nodeId: id['team-2'],
        useCase: 'security',
        reason: 'moved',
      });
      await restore('team-2', 'div-1');
    });
  });

  describe('dry run', () => {
    it('lists who gains and loses access and changes nothing', async () => {
      const before = await epoch('org-a');
      const moves = (await audit('tenant.moved', 'team-1')).length;
      const r = await move('root-admin', 'team-1', 'div-2', true);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as {
        dryRun: boolean;
        principals: { userId: string; gainedNodes: number; lostNodes: number }[];
        truncated: boolean;
      };
      expect(body.dryRun).toBe(true);
      expect(body.truncated).toBe(false);
      const by = (k: string) => body.principals.find((x) => x.userId === uid[k]);
      expect(by('viewer-d1')).toMatchObject({ lostNodes: 2, gainedNodes: 0 });
      expect(by('viewer-d2')).toMatchObject({ gainedNodes: 2, lostNodes: 0 });
      // admin-d1 loses the subtree, admin-d12 covers both sides and does not change
      expect(by('admin-d1')).toMatchObject({ lostNodes: 2 });
      expect(by('admin-d12')).toBeUndefined();
      expect(by('viewer-org')).toBeUndefined();
      expect(await epoch('org-a')).toBe(before);
      expect((await row('team-1')).parentId).toBe(id['div-1']);
      expect(await audit('tenant.moved', 'team-1')).toHaveLength(moves);
    });

    it('lists only users the caller may see', async () => {
      // leaf-admin covers div-1 and leaf-2 only; the users bound on div-2 are outside that
      await mkUser('leaf-admin', 'div-1');
      await bind('leaf-admin', 'div-1', 'admin', true);
      await bind('leaf-admin', 'leaf-2', 'admin', true);
      await mkUser('hidden-viewer', 'div-3');
      await bind('hidden-viewer', 'div-2', 'viewer', true); // gains team-1; nothing of it is covered
      const r = await move('leaf-admin', 'team-1', 'leaf-2', true);
      expect(r.statusCode, r.body).toBe(200);
      const ids = (r.json().principals as { userId: string }[]).map((x) => x.userId);
      expect(ids).not.toContain(uid['viewer-d2']);
      expect(ids).not.toContain(uid['hidden-viewer']);
      expect(ids).toContain(uid['viewer-d1']); // home div-1 is covered
      // an organisation administrator sees both
      const all = await move('root-admin', 'team-1', 'leaf-2', true);
      const allIds = (all.json().principals as { userId: string }[]).map((x) => x.userId);
      expect(allIds).toContain(uid['hidden-viewer']);
      expect(allIds).toContain(uid['viewer-d2']);
      await n.ctx.db
        .delete(tenantRoleBindings)
        .where(eq(tenantRoleBindings.userId, uid['hidden-viewer']!));
    });
  });

  describe('audit, atomicity, concurrency', () => {
    it('writes tenant.moved to the node, the old and the new parent with ids only', async () => {
      const counts = new Map<string, number>();
      for (const t of ['team-1', 'div-1', 'div-2', 'div-3'])
        counts.set(t, (await audit('tenant.moved', t)).length);
      expect((await move('root-admin', 'team-1', 'div-2')).statusCode).toBe(200);
      for (const t of ['team-1', 'div-1', 'div-2']) {
        const list = await audit('tenant.moved', t);
        expect(list.length, t).toBe(counts.get(t)! + 1);
        const e = list.at(-1);
        expect(e!.payload).toEqual({
          nodeId: id['team-1'],
          fromParentId: id['div-1'],
          toParentId: id['div-2'],
          nodes: 2,
          depthChange: 0,
          restrictionsDropped: 0,
          policiesWidened: 0,
          authority: 'inheriting_admin',
        });
        expect(e!.actor).toBe(uid['root-admin']);
      }
      expect(await audit('tenant.moved', 'div-3')).toHaveLength(counts.get('div-3')!);
      await restore('team-1', 'div-1');
    });

    it('a refused move changes nothing', async () => {
      const rows = JSON.stringify(await n.ctx.db.select().from(tenants).orderBy(asc(tenants.path)));
      const e = await epoch('org-a');
      expect((await move('root-admin', 'div-1', 'sub-1')).statusCode).toBe(422);
      expect((await move('direct-d2', 'team-1', 'div-2')).statusCode).toBe(403);
      expect(JSON.stringify(await n.ctx.db.select().from(tenants).orderBy(asc(tenants.path)))).toBe(
        rows,
      );
      expect(await epoch('org-a')).toBe(e);
    });

    it('two concurrent moves of the same node leave one consistent placement', async () => {
      const results = await Promise.all([
        move('root-admin', 'team-1', 'div-2'),
        move('root-admin', 'team-1', 'div-3'),
      ]);
      for (const r of results) expect([200, 409]).toContain(r.statusCode);
      expect(results.some((r) => r.statusCode === 200)).toBe(true);
      await consistent();
      await restore('team-1', 'div-1');
    });

    it('a move and a grant are serialised by the tree lock', async () => {
      await mkUser('late-viewer', 'div-3');
      const [m, g] = await Promise.all([
        move('root-admin', 'team-1', 'div-2'),
        n.req({
          method: 'POST',
          url: `/v1/tenants/${id['div-2']}/role-bindings`,
          payload: { userId: uid['late-viewer'], role: 'viewer', inherit: true },
          token: tok['root-admin']!,
        }),
      ]);
      expect(m.statusCode, m.body).toBe(200);
      expect(g.statusCode, g.body).toBe(201);
      // whichever came first, the grant on div-2 reaches the moved node afterwards
      expect((await visibleIds('late-viewer')).has(id['team-1']!)).toBe(true);
      await consistent();
      await restore('team-1', 'div-1');
      expect((await visibleIds('late-viewer')).has(id['team-1']!)).toBe(false);
    });
  });

  it('team members and agent bindings stay with their node', async () => {
    const team = await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'blue', name: 'blue' },
      headers: { 'x-oax-tenant': id['team-1']! },
      token: tok['root-admin']!,
    });
    expect(team.statusCode, team.body).toBe(201);
    await mkUser('team-op', 'div-3');
    await n.ctx.db
      .insert(teamMembers)
      .values({ teamId: team.json().id, userId: uid['team-op']!, role: 'operator' });
    expect((await move('root-admin', 'team-1', 'div-2')).statusCode).toBe(200);
    expect((await visibleIds('team-op')).has(id['team-1']!)).toBe(true);
    await restore('team-1', 'div-1');
  });
});
