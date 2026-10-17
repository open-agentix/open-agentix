import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { StepCredentials } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  agentVersions,
  auditLog,
  runNodeSessions,
  runSecretIssuances,
  runs,
  secrets,
  tenants,
} from '../src/db/schema.js';
import { RunNodesService } from '../src/services/run-nodes.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 S4, end to end: a scoped secret is resolved at review time, bound by the approval digest,
 * pinned in the published version and issued at run time to exactly the pinned secret.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.org,*.corp.example',
  OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
  OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
  OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
  OAX_ROLE_BINDINGS_READ: 'bindings',
  OAX_RATE_LIMIT_LOGIN_MAX: '1000',
};
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (res: { json: () => unknown }) => res.json() as Json;

let n: TestNode;
const id: Record<string, string> = {};
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
let seq = 0;
const canaries: string[] = [];
const value = (tag: string) => {
  const v = `canary-${tag}-${randomBytes(6).toString('hex')}`;
  canaries.push(v);
  return v;
};

const api = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Json,
) => n.req({ method, url, token, ...(payload ? { payload } : {}) });

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
async function mkUser(key: string, home: string, roles: string[]) {
  const res = await api(tok[home]!, 'POST', '/v1/users', {
    email: `${key}@sp.example.org`,
    displayName: key,
    password: PW,
    globalRoles: roles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@sp.example.org`, PW);
}

/** Creates a tenant secret at a node (by that node's admin) and returns its id. */
async function secret(node: string, name: string, v: string, extra: Json = {}): Promise<string> {
  const res = await api(tok[node]!, 'POST', '/v1/secrets', {
    scope: 'tenant',
    name,
    value: v,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return j(res).id;
}

interface Agent {
  id: string;
  name: string;
  creds: string[];
  egress: string;
}
const source = (
  name: string,
  version: string,
  creds: string[],
  egress: string,
  owner = 'nobody',
) => `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ${name}
version: ${version}
owner: ${owner}
runtime:
  runner: container
  egress: [${egress}]
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
${creds.length ? `    credentials:\n${creds.map((c, i) => `      - { secret: ${c}, env: CRED_${i} }`).join('\n')}` : ''}
---
`;
async function newAgent(
  creds: string[],
  egress = 'jira.example.org',
  owner = 'nobody',
): Promise<Agent> {
  const name = `sp-agent-${++seq}`;
  const res = await api(tok['author']!, 'POST', '/v1/agents', {
    source: source(name, '1.0.0', creds, egress, owner),
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id, name, creds, egress };
}
const bound = (review: Json) => ({
  expectedDigest: review.revision.digest,
  expectedExpansionDigest: review.digests.expansionDigest,
  expectedResolutionDigest: review.digests.resolutionDigest,
  expectedPolicyDigest: review.digests.policyDigest,
});
const openReview = async (a: Agent) => {
  const res = await api(tok['author']!, 'POST', `/v1/agents/${a.id}/reviews`);
  expect(res.statusCode, res.body).toBe(201);
  return j(res);
};
const approve = (review: Json) =>
  api(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
    decision: 'approve',
    ...bound(review),
  });
const getReview = async (rid: string) => j(await api(tok['author']!, 'GET', `/v1/reviews/${rid}`));
const publish = (a: Agent, review: Json) =>
  api(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`, {
    reviewId: review.id,
    expectedDigest: review.revision.digest,
  });
/** An agent whose review was approved but is not published yet. */
async function approved(creds: string[], egress?: string, owner?: string) {
  const a = await newAgent(creds, egress, owner);
  const review = await openReview(a);
  const d = await approve(review);
  expect(d.statusCode, d.body).toBe(201);
  return { a, review: await getReview(review.id) };
}
/** An agent published under an approved review. */
async function published(creds: string[], egress?: string, owner?: string) {
  const { a, review } = await approved(creds, egress, owner);
  const res = await publish(a, review);
  expect(res.statusCode, res.body).toBe(201);
  return { a, review, version: j(res).version };
}

async function newRun(a: Agent): Promise<string> {
  const res = await api(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, { data: { go: true } });
  expect(res.statusCode, res.body).toBe(202);
  const runId = j(res).id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
  return runId;
}
const session = (runId: string) =>
  n.services.runNodes.createSession(runId, 'w1', {
    agentId: 'research',
    input: {},
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
const credentials = (runId: string, token: string) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/credentials`,
    token,
    payload: { agentId: 'research' },
  });
/** Starts a run of the agent and asks the broker for the step credentials. */
async function issue(a: Agent) {
  const runId = await newRun(a);
  const s = await session(runId);
  const res = await credentials(runId, s.token);
  return { runId, res };
}
const auditOf = async (action: string, runId?: string) =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(auditLog.seq))
    .filter((e) => !runId || e.runId === runId)
    .map((e) => e.payload as Json);

/** Changes a policy column behind the service's back: the trigger forbids it unless disabled. */
async function policyUpdate(id: string, set: Partial<typeof secrets.$inferInsert>) {
  await n.ctx.db.execute(sql`alter table secrets disable trigger secrets_identity_immutable`);
  try {
    await n.ctx.db.update(secrets).set(set).where(eq(secrets.id, id));
  } finally {
    await n.ctx.db.execute(sql`alter table secrets enable trigger secrets_identity_immutable`);
  }
}

beforeAll(async () => {
  n = await testNode(ENV);
  await mkTenant('sp-root');
  await mkTenant('sp-a', id['sp-root']);
  await mkTenant('sp-b', id['sp-root']);
  await mkTenant('sp-c', id['sp-a']);
  await mkUser('author', 'sp-c', ['agent-maintainer']);
  await mkUser('rev1', 'sp-c', ['agent-maintainer']);
  const t = await api(tok['sp-c']!, 'POST', '/v1/teams', { slug: 'sp-team', name: 'Team' });
  expect(t.statusCode, t.body).toBe(201);
  id['sp-team'] = j(t).id;
}, 180_000);
afterAll(async () => n?.close());

describe('resolution at review time', () => {
  it('shows the resolution digest of concrete credentials, and a rotation does not change it', async () => {
    await secret('sp-root', 'rotating', value('r1'));
    const { review } = await approved(['tenant:rotating']);
    const before = review.digests.resolutionDigest;
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await n.ctx.db.select().from(secrets).where(eq(secrets.name, 'rotating'));
    const rot = await api(tok['sp-root']!, 'POST', `/v1/secrets/${row!.id}/rotate`, {
      value: value('r2'),
    });
    expect(rot.statusCode).toBe(200);
    expect((await getReview(review.id)).digests.resolutionDigest).toBe(before);
    expect((await getReview(review.id)).state).toBe('approved');
  });

  it('keeps the names-only digest for an agent without scoped references (old approvals stay valid)', async () => {
    const a = await newAgent(['plain-legacy']);
    const review = await openReview(a);
    const { secretResolutionDigest } = await import('@openagentix/core');
    expect(review.digests.resolutionDigest).toBe(secretResolutionDigest(['plain-legacy']));
  });

  it('binds to the owning node: the same name from another node is another resolution', async () => {
    await secret('sp-root', 'who-owns', value('w1'), { allowOverride: true });
    const a = await newAgent(['tenant:who-owns']);
    const first = (await openReview(a)).digests.resolutionDigest;
    await api(
      tok['author']!,
      'POST',
      `/v1/reviews/${(await api(tok['author']!, 'GET', `/v1/agents/${a.id}/reviews`)).json().items[0].id}/withdraw`,
    );
    await secret('sp-a', 'who-owns', value('w2'), { allowOverride: true });
    const second = (await openReview(a)).digests.resolutionDigest;
    expect(second).not.toBe(first);
  });
});

describe('publish', () => {
  it('pins the owning node and secret id of every scoped reference in the version', async () => {
    const sid = await secret('sp-root', 'pinned-1', value('p1'));
    const { review, version } = await published(['tenant:pinned-1', 'plain-legacy']);
    const [row] = await n.ctx.db.select().from(secrets).where(eq(secrets.id, sid));
    expect(row!.tenantId).toBe(id['sp-root']);
    const [v] = await n.ctx.db.select().from(agentVersions).where(eq(agentVersions.id, version.id));
    expect(v!.secretResolution).toEqual([
      { ref: 'plain-legacy', state: 'legacy' },
      {
        ref: 'tenant:pinned-1',
        state: 'resolved',
        scope: 'tenant',
        ownerNode: id['sp-root'],
        secretId: sid,
      },
    ]);
    expect(v!.resolutionDigest).toBe(review.digests.resolutionDigest);
  });

  it('leaves the approval stale when a nearer secret appears after the review', async () => {
    await secret('sp-root', 'late-shadow', value('ls1'), { allowOverride: true });
    const { a, review } = await approved(['tenant:late-shadow']);
    await secret('sp-a', 'late-shadow', value('ls2'));
    const res = await publish(a, review);
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res)).toMatchObject({
      error: 'approval_stale',
      details: { reason: 'secret_resolution_changed' },
    });
    const fresh = await getReview(review.id);
    expect(fresh.approvals[0].reasons).toContain('secret_resolution_changed');
  });

  it.each([
    ['deleted', 'not_found'],
    ['revoked', 'revoked'],
    ['expired', 'expired'],
    ['development-only', 'usage'],
    ['never created', 'not_found'],
  ])('refuses a %s secret', async (label, reason) => {
    const name = `pub-${label.replace(/[ -]/g, '')}`;
    const sid =
      label === 'never created'
        ? null
        : await secret(
            'sp-root',
            name,
            value(name),
            label === 'development-only' ? { usage: 'development' } : {},
          );
    // approved while the secret was fine (or, for a missing one, referenced from the start)
    const a = await newAgent([`tenant:${name}`]);
    const review = await openReview(a);
    if (sid) await approve(review);
    if (label === 'deleted') await api(tok['sp-root']!, 'DELETE', `/v1/secrets/${sid}`);
    if (label === 'revoked') await api(tok['sp-root']!, 'POST', `/v1/secrets/${sid}/revoke`);
    if (label === 'expired')
      await n.ctx.db
        .update(secrets)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(secrets.id, sid!));
    const res = await publish(a, await getReview(review.id));
    expect(res.statusCode, `${label}: ${res.body}`).toBe(422);
    expect(j(res)).toMatchObject({
      error: 'secret_not_usable',
      details: { references: [{ ref: `tenant:${name}`, reason }] },
    });
  });

  it('refuses when the resolution read at publish differs from what was approved (race guard)', async () => {
    await secret('sp-root', 'race-guard', value('rg'));
    const { a, review } = await approved(['tenant:race-guard']);
    const publisher = n.services.agents.publisher as unknown as {
      secretResolution: { pinsFor: (...args: unknown[]) => Promise<Json> };
    };
    const real = publisher.secretResolution.pinsFor.bind(publisher.secretResolution);
    const spy = vi
      .spyOn(publisher.secretResolution, 'pinsFor')
      .mockImplementationOnce(async (...args: unknown[]) => ({
        ...(await real(...args)),
        digest: 'f'.repeat(64),
      }));
    try {
      const res = await publish(a, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res)).toMatchObject({
        error: 'approval_stale',
        details: { reason: 'secret_resolution_changed' },
      });
    } finally {
      spy.mockRestore();
    }
    // nothing was published, and the same request succeeds once the read is consistent
    expect((await publish(a, review)).statusCode).toBe(201);
  });

  it('refuses a personal secret in a version', async () => {
    const a = await newAgent(['personal:mine']);
    const review = await openReview(a);
    const res = await publish(a, review);
    expect(res.statusCode, res.body).toBe(422);
    expect(j(res).error).toBe('personal_secret_in_version');
  });

  it('never resolves a secret of a descendant, a sibling, or another scope', async () => {
    await secret('sp-b', 'sibling-only', value('sb'));
    await secret('sp-c', 'own-node', value('oc'));
    const down = await newAgent(['tenant:sibling-only']);
    const r1 = await publish(down, await openReview(down));
    expect(j(r1).details.references[0].reason).toBe('not_found');
    // a team reference does not fall back to a tenant secret of the same name
    const team = await newAgent(['team:own-node'], 'jira.example.org', 'sp-team');
    const r2 = await publish(team, await openReview(team));
    expect(j(r2).details.references[0].reason).toBe('not_found');
  });

  it('resolves a team reference against the team of the agent', async () => {
    const res = await api(tok['sp-c']!, 'POST', '/v1/secrets', {
      scope: 'team',
      teamId: id['sp-team'],
      name: 'team-key',
      value: value('tk'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const { a } = await published(['team:team-key'], 'jira.example.org', 'sp-team');
    const out = await issue(a);
    expect(out.res.statusCode, out.res.body).toBe(200);
    // the same reference from an agent of no team does not resolve
    const loose = await newAgent(['team:team-key']);
    expect(j(await publish(loose, await openReview(loose))).error).toBe('secret_not_usable');
  });

  it('keeps the nearest owner: the node of the agent beats its ancestors', async () => {
    await secret('sp-root', 'near', value('n1'), { allowOverride: true });
    const mid = value('n2');
    await secret('sp-a', 'near', value('n2a'), { allowOverride: true });
    await secret('sp-c', 'near', mid);
    const { a } = await published(['tenant:near']);
    const out = await issue(a);
    expect((j(out.res) as StepCredentials).credentials[0]!.value).toBe(mid);
  });
});

describe('run time', () => {
  it('issues the pinned secret, audits the owner and version, and never the value', async () => {
    const v = value('issue');
    const sid = await secret('sp-root', 'run-key', v);
    const { a } = await published(['tenant:run-key']);
    const { runId, res } = await issue(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = j(res) as StepCredentials;
    expect(body.credentials).toEqual([{ secret: 'tenant:run-key', env: 'CRED_0', value: v }]);
    const [issued] = await auditOf('credential.issued', runId);
    expect(issued).toMatchObject({
      refs: ['tenant:run-key'],
      secrets: [
        {
          ref: 'tenant:run-key',
          scope: 'tenant',
          ownerNode: id['sp-root'],
          secretId: sid,
          secretVersion: 1,
          backend: 'internal',
        },
      ],
    });
    expect(JSON.stringify(await n.ctx.db.select().from(auditLog))).not.toContain(v);
  });

  it('a shadowing secret created after publish does not change the credential of the published version', async () => {
    const rootValue = value('base');
    await secret('sp-root', 'shadowed-later', rootValue, { allowOverride: true });
    const { a } = await published(['tenant:shadowed-later']);
    const shadow = value('shadow');
    await secret('sp-c', 'shadowed-later', shadow);
    const { res } = await issue(a);
    expect(res.statusCode, res.body).toBe(200);
    expect((j(res) as StepCredentials).credentials[0]!.value).toBe(rootValue);
    expect(res.body).not.toContain(shadow);
  });

  it('uses the new version after a rotation', async () => {
    const sid = await secret('sp-root', 'rotates', value('old'));
    const { a } = await published(['tenant:rotates']);
    const fresh = value('new');
    await api(tok['sp-root']!, 'POST', `/v1/secrets/${sid}/rotate`, { value: fresh });
    const { res } = await issue(a);
    expect((j(res) as StepCredentials).credentials[0]!.value).toBe(fresh);
  });

  it.each([
    [
      'revoked',
      'secret_unavailable',
      (sid: string) => api(tok['sp-root']!, 'POST', `/v1/secrets/${sid}/revoke`),
    ],
    [
      'deleted',
      'secret_unavailable',
      (sid: string) => api(tok['sp-root']!, 'DELETE', `/v1/secrets/${sid}`),
    ],
    [
      'expired',
      'secret_unavailable',
      (sid: string) =>
        n.ctx.db
          .update(secrets)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(secrets.id, sid)),
    ],
    [
      'made node-only',
      'secret_out_of_chain',
      (sid: string) => policyUpdate(sid, { inherit: false }),
    ],
  ])('fails closed when the pinned secret is %s', async (label, code, change) => {
    const sid = await secret('sp-root', `fc-${label.replace(' ', '-')}`, value(label));
    const { a } = await published([`tenant:fc-${label.replace(' ', '-')}`]);
    await change(sid);
    const { runId, res } = await issue(a);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(code);
    expect(await auditOf('secret.access_denied', runId)).toMatchObject([
      { ref: `tenant:fc-${label.replace(' ', '-')}`, code },
    ]);
    // nothing was issued, and the session is not consumed
    const [s] = await n.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.runId, runId));
    expect(s!.credentialsIssued).toEqual([]);
  });

  it('does not fall back to another node when the pinned secret is gone', async () => {
    const rootValue = value('fallback-root');
    await secret('sp-root', 'nofallback', rootValue, { allowOverride: true });
    const nearId = await secret('sp-a', 'nofallback', value('fallback-a'));
    const { a } = await published(['tenant:nofallback']);
    await api(tok['sp-a']!, 'DELETE', `/v1/secrets/${nearId}`);
    const { res } = await issue(a);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(rootValue);
  });

  it('fails closed when a node below the owner blocks the name (blockInherited)', async () => {
    await secret('sp-root', 'blockable', value('bl'));
    const { a } = await published(['tenant:blockable']);
    const put = await api(tok['sp-a']!, 'PUT', '/v1/secrets/policy', {
      blockInherited: ['block*'],
    });
    expect(put.statusCode, put.body).toBe(200);
    const { res } = await issue(a);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('secret_unavailable');
    await api(tok['sp-a']!, 'PUT', '/v1/secrets/policy', { blockInherited: [] });
    expect((await issue(a)).res.statusCode).toBe(200);
  });

  it('does not block a name the node owns itself', async () => {
    await api(tok['sp-c']!, 'PUT', '/v1/secrets/policy', { blockInherited: ['mine*'] });
    const v = value('mine');
    await secret('sp-c', 'mine-own', v);
    const { a } = await published(['tenant:mine-own']);
    const { res } = await issue(a);
    expect((j(res) as StepCredentials).credentials[0]!.value).toBe(v);
    await api(tok['sp-c']!, 'PUT', '/v1/secrets/policy', { blockInherited: [] });
  });

  it('refuses to issue after the owner leaves the chain (a node move)', async () => {
    await secret('sp-a', 'moves-with-a', value('mv'));
    const { a } = await published(['tenant:moves-with-a']);
    expect((await issue(a)).res.statusCode).toBe(200);
    const mv = await n.req({
      method: 'POST',
      url: `/v1/tenants/${id['sp-c']}/move`,
      payload: { parentId: id['sp-b'] },
    });
    expect(mv.statusCode, mv.body).toBe(200);
    try {
      const out = await issue(a);
      expect(out.res.statusCode).toBe(403);
      expect(out.res.body).toContain('secret_out_of_chain');
      // a root secret is still on the chain and keeps working for an agent that pinned it
    } finally {
      const back = await n.req({
        method: 'POST',
        url: `/v1/tenants/${id['sp-c']}/move`,
        payload: { parentId: id['sp-a'] },
      });
      expect(back.statusCode, back.body).toBe(200);
    }
  });

  it('does not accept scoped references in an MCP connection (they are not pinned)', async () => {
    await secret('sp-root', 'conn-secret', value('cs'));
    const saved = await api(tok['sp-c']!, 'POST', '/v1/connections', {
      name: 'jira',
      config: {
        transport: 'stdio',
        command: '/opt/mcp/bin/jira-mcp',
        envSecrets: { JIRA_TOKEN: 'tenant:conn-secret' },
        tools: { get_issue: { access: 'read' } },
      },
    });
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.body).not.toContain('canary');
  });

  it('refuses a secret whose allowedDestinations do not cover the step egress', async () => {
    await secret('sp-root', 'dest-ok', value('d1'), { allowedDestinations: ['jira.example.org'] });
    await secret('sp-root', 'dest-wild', value('d2'), { allowedDestinations: ['*.example.org'] });
    await secret('sp-root', 'dest-no', value('d3'), { allowedDestinations: ['*.corp.example'] });
    const ok = await published(['tenant:dest-ok']);
    expect((await issue(ok.a)).res.statusCode).toBe(200);
    const wild = await published(['tenant:dest-wild']);
    expect((await issue(wild.a)).res.statusCode).toBe(200);
    const no = await published(['tenant:dest-no']);
    const denied = await issue(no.a);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toContain('secret_destination_denied');
  });

  it('refuses usage:development secrets that were pinned before the usage changed', async () => {
    const sid = await secret('sp-root', 'turns-dev', value('td'));
    const { a } = await published(['tenant:turns-dev']);
    await policyUpdate(sid, { usage: 'development' });
    const { res } = await issue(a);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('secret_not_usable');
  });

  it('issues an imported pointer from the operator environment, under the tenant allowlist', async () => {
    await n.ctx.db
      .update(tenants)
      .set({ secretRefs: ['trivy-hook'] })
      .where(eq(tenants.id, id['sp-root']!));
    await n.ctx.db
      .update(tenants)
      .set({ secretRefs: ['trivy-hook'] })
      .where(eq(tenants.id, id['sp-c']!));
    const p = await api(tok['sp-root']!, 'POST', '/v1/secrets', {
      scope: 'tenant',
      name: 'imp',
      pointer: 'trivy-hook',
    });
    expect(p.statusCode, p.body).toBe(201);
    const { a } = await published(['tenant:imp']);
    const { res } = await issue(a);
    expect(res.statusCode, res.body).toBe(200);
    expect((j(res) as StepCredentials).credentials[0]!.value).toBe('hook-secret-1');
    // the run's tenant no longer allows the reference: the pointer is refused
    await n.ctx.db.update(tenants).set({ secretRefs: [] }).where(eq(tenants.id, id['sp-c']!));
    const denied = await issue(a);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toContain('secret_not_usable');
  });

  it('keeps unprefixed references working exactly as before', async () => {
    await n.ctx.db
      .update(tenants)
      .set({ secretRefs: ['mail-hook'] })
      .where(eq(tenants.id, id['sp-c']!));
    const { a } = await published(['mail-hook']);
    const { res } = await issue(a);
    expect(res.statusCode, res.body).toBe(200);
    expect((j(res) as StepCredentials).credentials[0]).toMatchObject({
      secret: 'mail-hook',
      value: 'mail-secret-1',
    });
    const closed = await newAgent(['gh-hook']);
    const review = await openReview(closed);
    await approve(review);
    const pub = await publish(closed, await getReview(review.id));
    expect(pub.statusCode).toBe(201);
    const denied = await issue(closed);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toContain('secret_not_allowed');
  });

  it('does not issue when the value cannot be remembered, and lets the step retry', async () => {
    const v = value('record-fails');
    await secret('sp-root', 'record-fails', v);
    const { a } = await published(['tenant:record-fails']);
    const runId = await newRun(a);
    const s = await session(runId);
    const store = (
      n.services.runNodes.scoped as unknown as { store: { recordIssued: () => Promise<void> } }
    ).store;
    const spy = vi.spyOn(store, 'recordIssued').mockRejectedValueOnce(new Error('disk full'));
    try {
      const failed = await credentials(runId, s.token);
      expect(failed.statusCode, failed.body).toBe(403);
      expect(failed.body).toContain('unavailable');
      expect(failed.body).not.toContain(v);
      expect(failed.body).not.toContain('disk full');
    } finally {
      spy.mockRestore();
    }
    // nothing was issued or remembered, and the issuance is given back
    const [row] = await n.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, s.sessionId));
    expect(row!.credentialsIssued).toEqual([]);
    expect(await n.services.runNodes.scoped!.issuedValues(runId)).toEqual([]);
    expect((await auditOf('credential.denied', runId)).map((p) => p['reason'])).toEqual([
      'unavailable',
    ]);
    const retry = await credentials(runId, s.token);
    expect(retry.statusCode, retry.body).toBe(200);
    expect((j(retry) as StepCredentials).credentials[0]!.value).toBe(v);
  });

  describe('redaction covers every value issued to the run', () => {
    const report = (v: string) => ({ text: `the token is ${v} ok`, nested: { again: [v] } });
    async function issued(name: string) {
      const v = value(name);
      const sid = await secret('sp-root', name, v);
      const { a } = await published([`tenant:${name}`]);
      const out = await issue(a);
      expect(out.res.statusCode, out.res.body).toBe(200);
      // sanity: before any change the value is scrubbed
      expect(JSON.stringify(await n.services.runNodes.scrub(out.runId, report(v)))).not.toContain(
        v,
      );
      return { v, sid, runId: out.runId };
    }
    const scrubbed = async (runId: string, v: string) =>
      !JSON.stringify(await n.services.runNodes.scrub(runId, report(v))).includes(v);

    it('after the secret was rotated', async () => {
      const { v, sid, runId } = await issued('scrub-rotated');
      const res = await api(tok['sp-root']!, 'POST', `/v1/secrets/${sid}/rotate`, {
        value: value('rot2'),
      });
      expect(res.statusCode).toBe(200);
      expect(await scrubbed(runId, v)).toBe(true);
    });

    it('after the secret was revoked', async () => {
      const { v, sid, runId } = await issued('scrub-revoked');
      expect((await api(tok['sp-root']!, 'POST', `/v1/secrets/${sid}/revoke`)).statusCode).toBe(
        200,
      );
      expect(await n.services.runNodes.scoped!.issuedValues(runId)).toContain(v);
      expect(await scrubbed(runId, v)).toBe(true);
    });

    it('after the secret was deleted', async () => {
      const { v, sid, runId } = await issued('scrub-deleted');
      expect((await api(tok['sp-root']!, 'DELETE', `/v1/secrets/${sid}`)).statusCode).toBe(204);
      expect(await scrubbed(runId, v)).toBe(true);
    });

    it('with a dynamic credential source too (the scoped branch is not behind the static guard)', async () => {
      const { v, runId } = await issued('scrub-dynamic');
      const dynamic = new RunNodesService(
        n.ctx,
        n.services.audit,
        n.services.agents,
        n.services.catalog,
        { name: 'dynamic', issue: async () => ({ value: 'dynamic-value-1' }) },
      );
      dynamic.scoped = n.services.runNodes.scoped;
      expect(await dynamic.knownSecrets(runId)).toContain(v);
    });

    it('keeps the issued value sealed, never in clear text, and only for that run', async () => {
      const { v, runId } = await issued('scrub-sealed');
      const rows = await n.ctx.db.select().from(runSecretIssuances);
      expect(JSON.stringify(rows)).not.toContain(v);
      expect(rows.length).toBeGreaterThan(0);
      expect(await n.services.runNodes.scoped!.issuedValues(randomUUID())).toEqual([]);
      expect(await n.services.runNodes.scoped!.issuedValues(runId)).toContain(v);
    });
  });
});

describe('pins that no publish can produce (defence in depth of the broker)', () => {
  /** A run row and a version row carrying exactly the given pins, written behind the API's back. */
  async function fixture(pins: unknown[], over: { teamId?: string | null } = {}) {
    const a = await newAgent([]);
    const versionId = randomUUID();
    await n.ctx.db.insert(agentVersions).values({
      id: versionId,
      agentId: a.id,
      version: '9.9.9',
      digest: randomBytes(32).toString('hex'),
      source: 's',
      definition: {},
      secretResolution: pins as never,
    });
    const run = {
      tenantId: id['sp-c']!,
      teamId: over.teamId ?? null,
      agentVersionId: versionId,
    } as unknown as typeof runs.$inferSelect;
    return run;
  }
  const prepare = (run: typeof runs.$inferSelect, ref: string) =>
    n.services.runNodes.scoped!.prepare(run, [ref], { destinations: [] });
  const resolved = (ref: string, scope: string, ownerNode: string, secretId: string) => ({
    ref,
    state: 'resolved',
    scope,
    ownerNode,
    secretId,
  });

  it('refuses a personal secret for a production run', async () => {
    const res = await api(tok['author']!, 'POST', '/v1/secrets', {
      scope: 'personal',
      name: 'pinned-personal',
      value: value('pp'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = await fixture([
      resolved('personal:pinned-personal', 'personal', id['sp-c']!, j(res).id),
    ]);
    await expect(prepare(run, 'personal:pinned-personal')).rejects.toMatchObject({
      code: 'secret_scope_not_usable',
    });
  });

  it('refuses the team secret of another team than the run', async () => {
    const t2 = await api(tok['sp-c']!, 'POST', '/v1/teams', { slug: 'sp-team-2', name: 'Two' });
    const mine = await api(tok['sp-c']!, 'POST', '/v1/secrets', {
      scope: 'team',
      teamId: id['sp-team'],
      name: 'pinned-team',
      value: value('pt'),
    });
    const ref = 'team:pinned-team';
    const pin = resolved(ref, 'team', id['sp-c']!, j(mine).id);
    await expect(prepare(await fixture([pin], { teamId: j(t2).id }), ref)).rejects.toMatchObject({
      code: 'secret_out_of_chain',
    });
    await expect(prepare(await fixture([pin], { teamId: null }), ref)).rejects.toMatchObject({
      code: 'secret_out_of_chain',
    });
    await expect(
      prepare(await fixture([pin], { teamId: id['sp-team']! }), ref),
    ).resolves.toHaveLength(1);
  });

  it('refuses a pin whose secret is not the one the reference names (scope and name)', async () => {
    const sid = await secret('sp-root', 'real-name', value('rn'));
    const other = await secret('sp-root', 'other-name', value('on'));
    const run = await fixture([
      resolved('tenant:real-name', 'tenant', id['sp-root']!, other),
      resolved('team:real-name', 'tenant', id['sp-root']!, sid),
    ]);
    await expect(prepare(run, 'tenant:real-name')).rejects.toMatchObject({
      code: 'secret_unavailable',
    });
    await expect(prepare(run, 'team:real-name')).rejects.toMatchObject({
      code: 'secret_unavailable',
    });
    const ok = await fixture([resolved('tenant:real-name', 'tenant', id['sp-root']!, sid)]);
    await expect(prepare(ok, 'tenant:real-name')).resolves.toHaveLength(1);
  });

  it('refuses an unresolved pin, a missing pin and a pin whose owner does not match', async () => {
    const sid = await secret('sp-root', 'pinned-odd', value('po'));
    const ref = 'tenant:pinned-odd';
    const run1 = await fixture([{ ref, state: 'unresolved', code: 'secret_not_found' }]);
    await expect(prepare(run1, ref)).rejects.toMatchObject({ code: 'secret_unavailable' });
    const run2 = await fixture([]);
    await expect(prepare(run2, ref)).rejects.toMatchObject({ code: 'secret_unavailable' });
    const run3 = await fixture([resolved(ref, 'tenant', id['sp-b']!, sid)]);
    await expect(prepare(run3, ref)).rejects.toMatchObject({ code: 'secret_unavailable' });
    const run4 = await fixture([resolved(ref, 'tenant', id['sp-root']!, sid)]);
    await expect(prepare(run4, ref)).resolves.toHaveLength(1);
  });
});

describe('nothing leaks', () => {
  it('has no canary value in any audit entry', async () => {
    const audit = JSON.stringify(await n.ctx.db.select().from(auditLog));
    for (const c of canaries) expect(audit).not.toContain(c);
    expect(RUN_TOKEN_SECRET).toBeTruthy();
  });
});
