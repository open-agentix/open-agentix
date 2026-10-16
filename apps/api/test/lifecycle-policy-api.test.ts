import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, tenants } from '../src/db/schema.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 S1: `GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle`: reading, writing, narrowing
 * only below a parent, permissions, visibility and audit.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let root: string;
let child: string;
let grandchild: string;
let adminRoot: string;
let adminChild: string;
let adminOther: string;
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};

const j = (res: { json: () => unknown }) => res.json() as Json;
const url = (id: string) => `/v1/tenants/${id}/settings/agent-lifecycle`;
const get = (token: string, id: string) => n.req({ method: 'GET', url: url(id), token });
const patch = (token: string, id: string, payload: Json) =>
  n.req({ method: 'PATCH', url: url(id), token, payload });

async function mkTenant(slug: string, parentId?: string) {
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug,
      name: slug,
      ...(parentId ? { parentId } : {}),
      admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return { id: j(r).id as string, token: await n.login(`admin@${slug}.example.org`, PW) };
}

beforeAll(async () => {
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode({ OAX_DATABASE_URL: db.url, OAX_RATE_LIMIT_LOGIN_MAX: '1000' });
  const a = await mkTenant('pol-root');
  root = a.id;
  adminRoot = a.token;
  const b = await mkTenant('pol-child', root);
  child = b.id;
  adminChild = b.token;
  const c = await mkTenant('pol-grand', child);
  grandchild = c.id;
  const o = await mkTenant('pol-other');
  adminOther = o.token;
  for (const [key, roles] of [
    ['auditor', ['auditor']],
    ['viewer', ['viewer']],
    ['maint', ['agent-maintainer']],
  ] as const) {
    const res = await n.req({
      method: 'POST',
      url: '/v1/users',
      token: adminRoot,
      payload: {
        email: `${key}@pol.example.org`,
        displayName: key,
        password: PW,
        globalRoles: roles,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    uid[key] = j(res).id;
    tok[key] = await n.login(`${key}@pol.example.org`, PW);
  }
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('reading', () => {
  it('returns the defaults, the own values and the digest of the effective policy', async () => {
    const res = await get(adminRoot, root);
    expect(res.statusCode, res.body).toBe(200);
    const v = j(res);
    expect(v.own).toEqual({});
    expect(v.effective).toMatchObject({
      requireApprovalForPublish: 'on', // more than one tenant: multi-tenant
      selfApproval: 'never',
      minApprovals: 1,
      allowedApproverRoles: ['admin', 'agent-maintainer'],
      approverScope: 'tenant',
      approvalExpiryHours: 168,
      allowTokenApprovals: false,
      approverIdentitySources: ['local', 'oidc', 'ldap'],
    });
    expect(Object.keys(v.effective)).not.toContain('breakGlass');
    expect(v.policyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets an auditor read and nobody without settings:read', async () => {
    expect((await get(tok['auditor']!, root)).statusCode).toBe(200);
    for (const who of ['viewer', 'maint'])
      expect((await get(tok[who]!, root)).statusCode, who).toBe(403);
  });

  it('is invisible across organisations and below a node without an inheriting binding', async () => {
    const foreign = await get(adminOther, root);
    const unknown = await get(adminOther, '00000000-0000-4000-8000-0000000000aa');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect((await get(adminRoot, child)).statusCode).toBe(404);
    expect((await patch(adminRoot, child, { minApprovals: 2 })).statusCode).toBe(404);
  });
});

describe('writing', () => {
  it('lets an administrator set values at the root, freely, and audits old and new', async () => {
    const res = await patch(adminRoot, root, {
      minApprovals: 2,
      allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'],
      productionUseCases: ['prod/**'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res).own).toEqual({
      minApprovals: 2,
      allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'],
      productionUseCases: ['prod/**'],
    });
    expect(j(res).effective.minApprovals).toBe(2);
    const entries = await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, root));
    const e = entries.filter((x) => x.action === 'tenant.lifecycle_policy_changed').pop()!;
    expect(e.payload).toMatchObject({
      fields: expect.arrayContaining([
        'minApprovals',
        'allowedApproverRoles',
        'productionUseCases',
      ]),
      from: { minApprovals: null },
      to: { minApprovals: 2 },
    });
    expect(e.tenantId).toBe(root);
  });

  it('writes nothing and audits nothing for an unchanged value', async () => {
    const before = (await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, root))).length;
    const res = await patch(adminRoot, root, { minApprovals: 2 });
    expect(res.statusCode).toBe(200);
    expect((await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, root))).length).toBe(
      before,
    );
  });

  it('removes a value with null so that the node inherits again', async () => {
    await patch(adminRoot, root, { approvalExpiryHours: 48 });
    const res = await patch(adminRoot, root, { approvalExpiryHours: null });
    expect(j(res).own.approvalExpiryHours).toBeUndefined();
    expect(j(res).effective.approvalExpiryHours).toBe(168);
  });

  it('refuses keys that do not exist, break-glass and binding age included, and invalid values', async () => {
    for (const body of [
      { breakGlass: true },
      { breakGlassRatifyHours: 4 },
      { approverBindingMinAgeHours: 24 },
      { pathRules: [] },
      { unknown: 1 },
    ]) {
      const res = await patch(adminRoot, root, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().message).toContain('unknown key');
    }
    for (const body of [
      {},
      { minApprovals: 6 },
      { minApprovals: 0 },
      { allowedApproverRoles: [] },
      { allowedApproverRoles: ['viewer'] },
      { approvalExpiryHours: 721 },
      { selfApproval: 'always' },
      { approverScope: 'all' },
      { allowTokenApprovals: 'true' },
      { productionUseCases: ['not a glob!'] },
    ]) {
      expect((await patch(adminRoot, root, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // nothing was written by the refused requests
    expect(j(await get(adminRoot, root)).own.selfApproval).toBeUndefined();
  });

  it('needs settings:write: an auditor reads, a maintainer and a viewer cannot write', async () => {
    for (const who of ['auditor', 'viewer', 'maint'])
      expect((await patch(tok[who]!, root, { minApprovals: 3 })).statusCode, who).toBe(403);
  });

  it('needs the scope on a token', async () => {
    const t = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      token: adminRoot,
      payload: { name: 'ro', scopes: ['settings:read'] },
    });
    expect((await patch(j(t).token, root, { minApprovals: 3 })).statusCode).toBe(403);
    expect((await get(j(t).token, root)).statusCode).toBe(200);
  });
});

describe('narrowing only below a parent', () => {
  it('lets a child tighten and refuses to loosen, naming the keys', async () => {
    await patch(adminRoot, root, {
      minApprovals: 2,
      allowTokenApprovals: true,
      publishBy: 'approver-only',
    });
    const ok = await patch(adminChild, child, { minApprovals: 3, allowTokenApprovals: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(j(ok).effective).toMatchObject({
      minApprovals: 3,
      allowTokenApprovals: false,
      publishBy: 'approver-only',
    });
    const loose = await patch(adminChild, child, { minApprovals: 1, publishBy: 'any-publisher' });
    expect(loose.statusCode).toBe(422);
    expect(loose.json()).toMatchObject({ error: 'not_narrowing' });
    expect(
      loose
        .json()
        .details.map((d: Json) => d.path)
        .sort(),
    ).toEqual(['minApprovals', 'publishBy']);
    // nothing of the refused request was stored
    expect(j(await get(adminChild, child)).own).toEqual({
      minApprovals: 3,
      allowTokenApprovals: false,
    });
  });

  it('refuses each key that would widen, one by one', async () => {
    await patch(adminRoot, root, {
      requireApprovalForPublish: 'on',
      approverScope: 'other-team',
      approvalExpiryHours: 24,
      approverIdentitySources: ['oidc', 'ldap'],
      allowDraftRuns: 'off',
      allowPersonalSecretsInDevRuns: false,
      allowPersonalSecretsInPublishedAgents: 'never',
      allowProductionSecretsInDraftRuns: false,
      gitUnsignedContributors: 'refuse',
      allowedApproverRoles: ['agent-maintainer'],
    });
    const widening: Json[] = [
      { requireApprovalForPublish: 'off' },
      { requireApprovalForPublish: 'production-only' },
      { approverScope: 'tenant' },
      { approverScope: 'team' },
      { approvalExpiryHours: 25 },
      { approverIdentitySources: ['oidc', 'local'] },
      { allowDraftRuns: 'on' },
      { allowDraftRuns: 'development-credentials' },
      { allowPersonalSecretsInDevRuns: true },
      { allowPersonalSecretsInPublishedAgents: 'with-approval' },
      { allowProductionSecretsInDraftRuns: true },
      { gitUnsignedContributors: 'declared-non-production' },
      { allowedApproverRoles: ['agent-maintainer', 'admin'] },
      { allowedApproverRoles: ['agent-developer'] },
    ];
    for (const body of widening) {
      const res = await patch(adminChild, child, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().error).toBe('not_narrowing');
    }
    // narrower or equal is fine
    const ok = await patch(adminChild, child, {
      approverScope: 'other-team',
      approvalExpiryHours: 12,
      approverIdentitySources: ['oidc'],
      allowedApproverRoles: ['agent-maintainer'],
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('clamps a stored value that became looser when the parent tightened', async () => {
    await patch(adminRoot, root, { approvalExpiryHours: 100 });
    await patch(adminChild, child, { approvalExpiryHours: 50 });
    // the root tightens below what the child stores: the child's effective value follows
    await patch(adminRoot, root, { approvalExpiryHours: 10 });
    const v = j(await get(adminChild, child));
    expect(v.own.approvalExpiryHours).toBe(50);
    expect(v.effective.approvalExpiryHours).toBe(10);
  });

  it('applies down the whole chain', async () => {
    const [row] = await n.ctx.db.select().from(tenants).where(eq(tenants.id, grandchild));
    expect(row).toBeDefined();
    const eff = await n.services.lifecyclePolicy.effectiveForTenant(grandchild);
    expect(eff.minApprovals).toBeGreaterThanOrEqual(3);
    expect(eff.allowTokenApprovals).toBe(false);
  });

  it('lets a platform operator write at any node, still narrowing below a parent', async () => {
    const ok = await n.req({ method: 'PATCH', url: url(grandchild), payload: { minApprovals: 5 } });
    expect(ok.statusCode, ok.body).toBe(200);
    const loose = await n.req({
      method: 'PATCH',
      url: url(grandchild),
      payload: { minApprovals: 2 },
    });
    expect(loose.statusCode).toBe(422);
  });

  it('merges concurrent writes of a parent and a child without ever leaving a looser child', async () => {
    await patch(adminRoot, root, { minApprovals: 2 });
    const [a, b] = await Promise.all([
      patch(adminRoot, root, { minApprovals: 4 }),
      patch(adminChild, child, { minApprovals: 3 }),
    ]);
    expect([200, 422]).toContain(a.statusCode);
    expect([200, 422]).toContain(b.statusCode);
    const parent = (await n.services.lifecyclePolicy.effectiveForTenant(root)).minApprovals;
    const kid = (await n.services.lifecyclePolicy.effectiveForTenant(child)).minApprovals;
    expect(kid).toBeGreaterThanOrEqual(parent);
  });
});

describe('a single tenant installation', () => {
  it('defaults the approval requirement to off', async () => {
    const solo = await testNode({ OAX_RATE_LIMIT_LOGIN_MAX: '1000' });
    try {
      const res = await solo.req({
        method: 'GET',
        url: url('00000000-0000-4000-8000-000000000001'),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().effective.requireApprovalForPublish).toBe('off');
    } finally {
      await solo.close();
    }
  });

  it('refuses a bad installation default at start', async () => {
    await expect(
      testNode({ OAX_LIFECYCLE_ALLOWED_APPROVER_ROLES: 'admin,viewer' }),
    ).rejects.toThrow();
    await expect(testNode({ OAX_LIFECYCLE_MIN_APPROVALS: '9' })).rejects.toThrow();
    await expect(testNode({ OAX_LIFECYCLE_REQUIRE_APPROVAL: 'sometimes' })).rejects.toThrow();
  });

  it('takes the installation defaults from the environment', async () => {
    const custom = await testNode({
      OAX_RATE_LIMIT_LOGIN_MAX: '1000',
      OAX_LIFECYCLE_REQUIRE_APPROVAL: 'production-only',
      OAX_LIFECYCLE_MIN_APPROVALS: '2',
      OAX_LIFECYCLE_ALLOWED_APPROVER_ROLES: 'agent-maintainer,operator',
      OAX_LIFECYCLE_APPROVAL_EXPIRY_HOURS: '24',
      OAX_LIFECYCLE_ALLOW_TOKEN_APPROVALS: 'true',
    });
    try {
      const res = await custom.req({
        method: 'GET',
        url: url('00000000-0000-4000-8000-000000000001'),
      });
      expect(res.json().effective).toMatchObject({
        requireApprovalForPublish: 'production-only',
        minApprovals: 2,
        allowedApproverRoles: ['agent-maintainer', 'operator'],
        approvalExpiryHours: 24,
        allowTokenApprovals: true,
      });
    } finally {
      await custom.close();
    }
  });
});
