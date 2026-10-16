import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantRoleBindings } from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres } from './db-targets.js';
import { buildWorld, type World } from './use-case-world.js';

/**
 * ADR 0017 S1 on the resolver read path (`OAX_ROLE_BINDINGS_READ=bindings`): inherited bindings,
 * use-case bindings (which never carry `agents:approve`), the pentest role, a platform operator acting
 * in a sub-tenant and the isolation between organisations.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let w: World;
let secureReview = '';
const j = (res: { json: () => unknown }) => res.json() as Json;

/** A new draft of `agent` written by `who` (so that there is something to review). */
async function edit(
  who: string,
  key: string,
  name: string,
  version: string,
  useCase?: string,
  acting?: string,
) {
  const extra = useCase ? `labels:\n  useCase: ${useCase}` : '';
  const res = await w.req(
    who,
    'PUT',
    `/v1/agents/${w.agent[key]}/draft`,
    { source: agentSource(name, 'nobody', version, extra) },
    acting,
  );
  expect(res.statusCode, res.body).toBe(200);
}
const open = (who: string, key: string, acting?: string) =>
  w.req(who, 'POST', `/v1/agents/${w.agent[key]}/reviews`, undefined, acting);
const decide = (who: string, review: Json, decision = 'approve', acting?: string) =>
  w.req(
    who,
    'POST',
    `/v1/reviews/${review.id}/decisions`,
    { decision, expectedDigest: review.revision.digest },
    acting,
  );

beforeAll(async () => {
  const target = PG_URL ? await openPostgres() : await openPglite();
  w = await buildWorld(target, { OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on' });
  for (const k of ['maint-root', 'maint-flat', 'maint-uc', 'pt', 'granted'])
    await w.mkUser(k, 'org-a');
  await w.bind('maint-root', 'org-a', 'agent-maintainer', { inherit: true });
  await w.bind('maint-flat', 'org-a', 'agent-maintainer');
  await w.bind('maint-uc', 'org-a', 'agent-maintainer', { useCase: 'sec' });
  await w.n.ctx.db.insert(tenantRoleBindings).values({
    id: randomUUID(),
    userId: w.uid['pt']!,
    tenantId: w.id['org-a']!,
    role: 'pentest',
    inherit: false,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    source: 'grant',
  });
  for (const k of ['maint-root', 'maint-flat', 'maint-uc', 'pt', 'granted']) await w.relogin(k);
}, 240_000);
afterAll(async () => w?.close());

describe('approvals on the resolver read path', () => {
  it('lets an inheriting maintainer of the parent decide in a sub-tenant, and traces the binding', async () => {
    await edit('admin-u1', 'a-u1', 'a-u1', '1.0.1', 'anything');
    const review = j(await open('admin-u1', 'a-u1'));
    expect(review.contributors).toContain(w.uid['admin-u1']);
    const res = await decide('maint-root', review, 'approve', 'unit-1');
    expect(res.statusCode, res.body).toBe(201);
    const ref = j(res).decision.bindingRefs[0];
    expect(ref).toMatchObject({ role: 'agent-maintainer', source: 'grant', grantedBy: null });
    expect(j(res).decision.actingTenantId).toBe(w.id['unit-1']);
  });

  it('does not reach a sub-tenant with a binding that does not inherit', async () => {
    await edit('admin-u1', 'a-u1sub', 'a-u1sub', '1.0.1', undefined, 'unit-1-sub');
    const review = j(await open('admin-u1', 'a-u1sub', 'unit-1-sub'));
    const res = await decide('maint-flat', review, 'approve', 'unit-1-sub');
    expect(res.statusCode).toBe(404);
  });

  it('refuses a binding that a contributor granted, also on the resolver path', async () => {
    await w.n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: w.uid['granted']!,
      tenantId: w.id['org-a']!,
      role: 'agent-maintainer',
      inherit: false,
      source: 'grant',
      grantedBy: w.uid['root-admin']!,
    });
    await w.relogin('granted');
    await edit('root-admin', 'a-ops', 'a-ops', '1.0.1', 'ops');
    const review = j(await open('root-admin', 'a-ops'));
    const res = await decide('granted', review);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');
  });

  it('does not count a binding that a contributor granted through the role-binding API', async () => {
    await w.mkUser('api-granted', 'org-a');
    const granted = await w.req(
      'root-admin',
      'POST',
      `/v1/tenants/${w.id['org-a']}/role-bindings`,
      {
        userId: w.uid['api-granted'],
        role: 'agent-maintainer',
        inherit: false,
      },
    );
    expect(granted.statusCode, granted.body).toBe(201);
    await w.relogin('api-granted');
    await edit('root-admin', 'a-none', 'a-none', '1.0.1');
    const review = j(await open('root-admin', 'a-none'));
    const res = await decide('api-granted', review);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');
  });

  it('treats a PATCH that widens a binding as a new grant by the contributor who made it', async () => {
    await w.mkUser('widened', 'org-a');
    await w.bind('widened', 'org-a', 'operator');
    const [row] = await w.n.ctx.db
      .select()
      .from(tenantRoleBindings)
      .where(
        and(
          eq(tenantRoleBindings.userId, w.uid['widened']!),
          eq(tenantRoleBindings.role, 'operator'),
        ),
      );
    expect(row!.grantedBy).toBeNull();
    const patched = await w.req(
      'root-admin',
      'PATCH',
      `/v1/tenants/${w.id['org-a']}/role-bindings/${row!.id}`,
      {
        role: 'agent-maintainer',
      },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    const [after] = await w.n.ctx.db
      .select()
      .from(tenantRoleBindings)
      .where(eq(tenantRoleBindings.id, row!.id));
    expect(after!.grantedBy).toBe(w.uid['root-admin']);
    await w.relogin('widened');
    await edit('root-admin', 'a-appsec', 'a-appsec', '1.0.2', 'sec/appsec');
    const review = j(await open('root-admin', 'a-appsec'));
    const res = await decide('widened', review);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');
  });

  it('never lets a use-case binding decide: agents:approve is not a use-case permission (fail closed)', async () => {
    await edit('root-admin', 'a-sec', 'a-sec', '1.0.1', 'sec');
    const opened = await open('maint-uc', 'a-sec');
    // a use-case maintainer holds agents:write for the use case, so it may open the review ...
    expect(opened.statusCode, opened.body).toBe(201);
    const review = j(opened);
    // ... but deciding is refused before the handler runs, even for somebody who did not write the draft
    const res = await decide('maint-uc', review);
    expect(res.statusCode).toBe(403);
    // and reading the review stays possible through the use case
    expect((await w.req('maint-uc', 'GET', `/v1/reviews/${review.id}`)).statusCode).toBe(200);
    // a node-wide maintainer decides it
    expect((await decide('maint-root', review)).statusCode).toBe(201);
  });

  it('lets a platform operator decide in a sub-tenant as a distinct person', async () => {
    await edit('root-admin', 'a-u2', 'a-u2', '1.0.1', 'sec', 'unit-2');
    const review = j(await open('root-admin', 'a-u2', 'unit-2'));
    const res = await w.n.req({
      method: 'POST',
      url: `/v1/reviews/${review.id}/decisions`,
      headers: { 'x-oax-tenant': w.id['unit-2']! },
      payload: { decision: 'approve', expectedDigest: review.revision.digest },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(j(res).decision.bindingRefs[0]).toMatchObject({ source: 'platform', grantedBy: null });
  });

  it('keeps a pentest role read-only', async () => {
    await edit('root-admin', 'a-secure', 'a-secure', '1.0.1', 'secure');
    const review = j(await open('root-admin', 'a-secure'));
    secureReview = review.id;
    expect((await w.req('pt', 'GET', `/v1/reviews/${review.id}`)).statusCode).toBe(200);
    expect(
      (await w.req('pt', 'GET', `/v1/agents/${w.agent['a-secure']}/revisions`)).statusCode,
    ).toBe(200);
    expect((await open('pt', 'a-secure')).statusCode).toBe(403);
    expect((await decide('pt', review)).statusCode).toBe(403);
    expect((await w.req('pt', 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode).toBe(403);
    expect(
      (
        await w.req('pt', 'PATCH', `/v1/tenants/${w.id['org-a']}/settings/agent-lifecycle`, {
          minApprovals: 2,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await w.req('pt', 'GET', `/v1/tenants/${w.id['org-a']}/settings/agent-lifecycle`))
        .statusCode,
    ).toBe(200);
  });

  it('honours a role restriction: a reviewer whose agents:approve was restricted is not eligible (ADR 0014 S9)', async () => {
    await w.mkUser('maint-r', 'org-a');
    await w.bind('maint-r', 'org-a', 'agent-maintainer', { inherit: true });
    await w.relogin('maint-r');
    // the review of a-u1 opened in the first test is still open
    const open409 = j(await open('admin-u1', 'a-u1'));
    const review = j(await w.req('admin-u1', 'GET', `/v1/reviews/${open409.details.reviewId}`));
    expect(review.revision.digest).toBeTruthy();
    const base = `/v1/tenants/${w.id['org-a']}/role-restrictions`;
    const restrict = await w.req('root-admin', 'PUT', base, {
      role: 'agent-maintainer',
      permissions: ['agents:approve'],
    });
    expect(restrict.statusCode, restrict.body).toBe(200);
    try {
      const refused = await decide('maint-r', review, 'approve', 'unit-1');
      expect(refused.statusCode, refused.body).toBe(403);
      // the route already needs agents:approve, which the restriction removed; either way refused
      expect(['forbidden', 'not_eligible']).toContain(j(refused).error);
    } finally {
      expect(
        (await w.req('root-admin', 'DELETE', `${base}?role=agent-maintainer`)).statusCode,
      ).toBe(204);
    }
    // without the restriction the same reviewer decides
    expect((await decide('maint-r', review, 'approve', 'unit-1')).statusCode).toBe(201);
  });

  it('is invisible to another organisation, even to its administrator', async () => {
    const some = secureReview;
    for (const [method, url] of [
      ['GET', `/v1/reviews/${some}`],
      ['POST', `/v1/reviews/${some}/withdraw`],
      ['GET', `/v1/agents/${w.agent['a-secure']}/reviews`],
      ['GET', `/v1/agents/${w.agent['a-secure']}/revisions`],
      ['GET', `/v1/tenants/${w.id['org-a']}/settings/agent-lifecycle`],
    ] as const) {
      const res = await w.req('b-admin', method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, url).toBe(404);
    }
  });
});
