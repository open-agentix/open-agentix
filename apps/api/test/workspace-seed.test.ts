import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNodeSessions, runs } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
};

const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: seed-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: []
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
agents:
  - id: fix
    provider: simulated
    model: sim-1
    instructions: Fix.
    outputs: [{ format: pull-request, target: dogfood-sandbox }]
  - id: other
    provider: simulated
    model: sim-1
    instructions: Other.
---
`;

const ARCHIVE = Buffer.concat([Buffer.from('seed archive bytes '), Buffer.alloc(900, 7)]);
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex');
const COMMIT = 'c'.repeat(40);

let n: TestNode;
let agentId: string;

async function newRun(worker = 'w1'): Promise<string> {
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { issue: { number: 1, title: 'x' } } },
  });
  const id = res.json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: worker,
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, id));
  return id;
}
const session = (runId: string, agent = 'fix', worker = 'w1') =>
  n.services.runNodes.createSession(runId, worker, {
    agentId: agent,
    input: {},
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
const store = (sessionId: string, archive = ARCHIVE, worker = 'w1') =>
  n.services.runNodes.storeSeed(sessionId, worker, {
    archive,
    target: 'dogfood-sandbox',
    commit: COMMIT,
    files: 3,
    agentId: 'fix',
  });
const get = (runId: string, token: string, agent = 'fix') =>
  n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/workspace?agentId=${agent}`, token });
const auditOf = async (runId: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` })).json().items as {
    action: string;
    payload: Record<string, unknown>;
  }[];

beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => n.close());

describe('workspace seed endpoint', () => {
  it('delivers the archive with its digest, no-store, and audits digests only', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const stored = await store(s.sessionId);
    expect(stored).toEqual({ sha256: DIGEST, bytes: ARCHIVE.length });
    const res = await get(runId, s.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-tar');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-oax-seed-sha256']).toBe(DIGEST);
    expect(Buffer.from(res.rawPayload).equals(ARCHIVE)).toBe(true);
    const audit = await auditOf(runId);
    expect(audit.find((e) => e.action === 'workspace.prepared')!.payload).toMatchObject({
      runId,
      agentId: 'fix',
      target: 'dogfood-sandbox',
      sha: COMMIT,
      bytes: ARCHIVE.length,
      files: 3,
      digest: DIGEST,
    });
    expect(audit.find((e) => e.action === 'workspace.fetched')!.payload).toMatchObject({
      agentId: 'fix',
      bytes: ARCHIVE.length,
      digest: DIGEST,
    });
    expect(JSON.stringify(audit)).not.toContain(ARCHIVE.toString('base64'));
    // the bytes are gone from the session row after the one fetch
    const [row] = await n.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, s.sessionId));
    expect(row!.workspaceSeed).toBeNull();
    expect(row!.workspaceSeedSha256).toBe(DIGEST);
    expect(row!.workspaceSeedFetchedAt).not.toBeNull();
  });

  it('serves the seed once per session (second fetch is a 409)', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await store(s.sessionId);
    expect((await get(runId, s.token)).statusCode).toBe(200);
    const again = await get(runId, s.token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('workspace_seed_already_fetched');
    expect(again.rawPayload.includes(ARCHIVE.subarray(0, 12))).toBe(false);
  });

  it('answers 404 when no seed was stored', async () => {
    const runId = await newRun();
    const s = await session(runId);
    expect((await get(runId, s.token)).statusCode).toBe(404);
  });

  it('is bound to the run, the step and the session', async () => {
    const runId = await newRun();
    const other = await newRun();
    const s = await session(runId);
    await store(s.sessionId);
    // another run's id with this run's token
    expect((await get(other, s.token)).statusCode).toBe(403);
    // another step name
    expect((await get(runId, s.token, 'other')).statusCode).toBe(403);
    // no token, an admin token (not a run token) and a garbage token
    expect((await get(runId, '')).statusCode).toBe(401);
    expect((await get(runId, n.admin)).statusCode).toBe(401);
    expect((await get(runId, 'oaxrt.x.y')).statusCode).toBe(401);
    // the orchestrator's own unscoped token is not a node token either
    const orchestrator = n.services.control.issueToken(runId, 'w1');
    expect([401, 403]).toContain((await get(runId, orchestrator)).statusCode);
    // after all those refusals the node can still fetch its seed
    expect((await get(runId, s.token)).statusCode).toBe(200);
  });

  it('is dead once the session is revoked and drops an unfetched seed', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await store(s.sessionId);
    await n.services.runNodes.revoke(s.sessionId, 'step_end');
    expect((await get(runId, s.token)).statusCode).toBe(401);
    const [row] = await n.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, s.sessionId));
    expect(row!.workspaceSeed).toBeNull();
  });

  it('does not hand a seed to a session of another orchestrator or a revoked one', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await expect(store(s.sessionId, ARCHIVE, 'someone-else')).rejects.toMatchObject({
      statusCode: 409,
    });
    await n.services.runNodes.revoke(s.sessionId, 'step_end');
    await expect(store(s.sessionId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses empty and oversized seeds', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await expect(store(s.sessionId, Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 413 });
    await expect(store(s.sessionId, Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it('stores the archive as given: the digest is computed by the control node', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const a = Buffer.from('another archive');
    const stored = await store(s.sessionId, a);
    expect(stored.sha256).toBe(createHash('sha256').update(a).digest('hex'));
    const res = await get(runId, s.token);
    expect(res.headers['x-oax-seed-sha256']).toBe(stored.sha256);
  });
});

describe('patch attachment in the node result', () => {
  const PATCH =
    'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n';
  const attachment = (over: Record<string, unknown> = {}) => ({
    patch: PATCH,
    patchSha256: createHash('sha256').update(PATCH).digest('hex'),
    changedFiles: [{ path: 'src/a.js', status: 'modified', additions: 1, deletions: 1 }],
    lastTestRun: { passed: true, exitCode: 0, timedOut: false, durationMs: 5, file: null },
    fullSuitePassed: true,
    treeMatchesLastRun: true,
    testedFinalTree: true,
    ...over,
  });
  const post = (runId: string, token: string, patch: unknown) =>
    n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/handover/result`,
      token,
      payload: { agentId: 'fix', format: 'pull-request', content: 'done', patch },
    });

  it('keeps the patch unchanged for the orchestrator (not rewritten by the scrubber)', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await post(runId, s.token, attachment());
    expect(res.statusCode, res.body).toBe(204);
    const result = await n.services.runNodes.resultOf(s.sessionId);
    expect(result?.patch).toEqual(attachment());
    // read once: gone afterwards
    expect(await n.services.runNodes.resultOf(s.sessionId)).toBeNull();
  });

  it('rejects a malformed attachment', async () => {
    const runId = await newRun();
    const s = await session(runId);
    for (const bad of [
      attachment({ patchSha256: 'xyz' }),
      attachment({ patch: '' }),
      attachment({ extra: true }),
      attachment({ patch: 'x'.repeat(131_073) }),
      attachment({
        changedFiles: Array(101).fill({ path: 'a', status: 'added', additions: 0, deletions: 0 }),
      }),
    ])
      expect((await post(runId, s.token, bad)).statusCode).toBe(400);
  });
});
