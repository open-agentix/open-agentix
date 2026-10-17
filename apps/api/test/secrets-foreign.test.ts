import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

/**
 * A version that pins a tenant secret of ANOTHER node (inherited from an ancestor) always needs an
 * approved review, even where the lifecycle policy does not require approval (ADR 0017 section 13.3,
 * review of slice S4). Own-node and own-team secrets do not.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (res: { json: () => unknown }) => res.json() as Json;

let n: TestNode;
const id: Record<string, string> = {};
const tok: Record<string, string> = {};
let seq = 0;
let team: string;

const api = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Json) =>
  n.req({ method, url, token, ...(payload ? { payload } : {}) });

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
  id[slug] = j(r).id;
  tok[slug] = await n.login(`admin@${slug}.example.org`, PW);
}
async function mkUser(key: string) {
  const res = await api(tok['fr-child']!, 'POST', '/v1/users', {
    email: `${key}@fr.example.org`,
    displayName: key,
    password: PW,
    globalRoles: ['agent-maintainer'],
  });
  expect(res.statusCode, res.body).toBe(201);
  tok[key] = await n.login(`${key}@fr.example.org`, PW);
}
const secret = async (node: string, name: string, body: Json = {}) => {
  const res = await api(tok[node]!, 'POST', '/v1/secrets', {
    scope: 'tenant',
    name,
    value: `value-${randomBytes(6).toString('hex')}`,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
};
const source = (name: string, ref: string, owner = 'nobody') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: ${owner}
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Summarise the event.
    credentials:
      - { secret: "${ref}", env: THE_TOKEN }
---
`;
async function agent(ref: string, owner?: string) {
  const res = await api(tok['author']!, 'POST', '/v1/agents', {
    source: source(`fr-agent-${++seq}`, ref, owner),
  });
  expect(res.statusCode, res.body).toBe(201);
  return j(res).id as string;
}
const publish = (agentId: string, body?: Json) =>
  api(tok['author']!, 'POST', `/v1/agents/${agentId}/publish`, body);
const openReview = async (agentId: string) => {
  const res = await api(tok['author']!, 'POST', `/v1/agents/${agentId}/reviews`);
  expect(res.statusCode, res.body).toBe(201);
  return j(res);
};
const approve = (review: Json) =>
  api(tok['rev']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
    decision: 'approve',
    expectedDigest: review.revision.digest,
    expectedExpansionDigest: review.digests.expansionDigest,
    expectedResolutionDigest: review.digests.resolutionDigest,
    expectedPolicyDigest: review.digests.policyDigest,
  });

beforeAll(async () => {
  n = await testNode({
    OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
    OAX_LIFECYCLE_REQUIRE_APPROVAL: 'off',
    OAX_ROLE_BINDINGS_READ: 'bindings',
    OAX_RATE_LIMIT_LOGIN_MAX: '1000',
  });
  await mkTenant('fr-root');
  await mkTenant('fr-child', id['fr-root']);
  await mkUser('author');
  await mkUser('rev');
  const t = await api(tok['fr-child']!, 'POST', '/v1/teams', { slug: 'fr-team', name: 'T' });
  team = j(t).id;
  await secret('fr-root', 'org-key', { allowOverride: true });
  await secret('fr-child', 'own-key');
  const own = await api(tok['fr-child']!, 'POST', '/v1/secrets', {
    scope: 'team',
    teamId: team,
    name: 'team-key',
    value: 'team-value-0001',
  });
  expect(own.statusCode, own.body).toBe(201);
}, 180_000);
afterAll(async () => n?.close());

describe('foreign secrets need an approved review whatever the policy says', () => {
  it('lets a secret of the own node and of the own team be published without a review', async () => {
    const a = await agent('tenant:own-key');
    expect((await publish(a)).statusCode).toBe(201);
    const b = await agent('team:team-key', 'fr-team');
    const res = await publish(b);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('refuses an inherited secret without a review, with a code that names the secret', async () => {
    const a = await agent('tenant:org-key');
    const res = await publish(a);
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res)).toMatchObject({
      error: 'approval_required_for_foreign_secret',
      details: {
        missing: ['reviewId', 'expectedDigest'],
        foreignSecrets: [{ ref: 'tenant:org-key', scope: 'tenant', ownerNode: id['fr-root'] }],
      },
    });
    expect(res.body).not.toContain('value-');
  });

  it('shows the approvers whose secret it is, and that approval is required', async () => {
    const a = await agent('tenant:org-key');
    const review = await openReview(a);
    expect(review.approvalRequired).toBe(true);
    expect(review.secrets).toEqual([
      expect.objectContaining({
        ref: 'tenant:org-key',
        state: 'resolved',
        scope: 'tenant',
        foreign: true,
        ownerNode: { id: id['fr-root'], slugPath: 'fr-root' },
      }),
    ]);
  });

  it('refuses a review that is not approved, and publishes an approved one', async () => {
    const a = await agent('tenant:org-key');
    const review = await openReview(a);
    const body = { reviewId: review.id, expectedDigest: review.revision.digest };
    const early = await publish(a, body);
    expect(early.statusCode).toBe(409);
    expect(j(early).error).toBe('approval_insufficient');
    expect((await approve(review)).statusCode).toBe(201);
    const ok = await publish(a, body);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('also holds when the author is the only one who could publish: no role skips it', async () => {
    const a = await agent('tenant:org-key');
    const res = await api(tok['fr-child']!, 'POST', `/v1/agents/${a}/publish`);
    expect(res.statusCode).toBe(409);
    expect(j(res).error).toBe('approval_required_for_foreign_secret');
  });

  it('does not mark an own secret as foreign in the review', async () => {
    const a = await agent('tenant:own-key');
    const review = await openReview(a);
    expect(review.secrets[0]).toMatchObject({ foreign: false });
    expect(review.approvalRequired).toBe(false);
  });
});
