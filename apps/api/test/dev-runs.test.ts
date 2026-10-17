import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { StepCredentials } from '@openagentix/core';
import { signWebhook } from '@openagentix/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentVersions, auditLog, devRunDefinitions, runs, secrets } from '../src/db/schema.js';
import { MAX_ACTIVE_DEV_RUNS_PER_USER } from '../src/services/dev-runs.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 S5: development runs of draft revisions and personal secrets. The security requirements
 * are tested one by one: a development run acts as its caller only; personal secrets exist only in
 * development runs of their owner; the usage matrix; a draft cannot be triggered by an event.
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
    email: `${key}@dv.example.org`,
    displayName: key,
    password: PW,
    globalRoles: roles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@dv.example.org`, PW);
}

/** A tenant secret created by the admin of a node. */
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
/** A personal secret of a user. */
async function personal(user: string, name: string, v: string, extra: Json = {}): Promise<string> {
  const res = await api(tok[user]!, 'POST', '/v1/secrets', {
    scope: 'personal',
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
}
const source = (name: string, creds: string[], extra = '', owner = 'nobody') => `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ${name}
version: 1.0.0
owner: ${owner}
runtime:
  runner: container
  egress: [jira.example.org]
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.${extra}
${creds.length ? `    credentials:\n${creds.map((c, i) => `      - { secret: ${c}, env: CRED_${i} }`).join('\n')}` : ''}
---
`;
async function newAgent(creds: string[], by = 'author', owner = 'nobody'): Promise<Agent> {
  const name = `dv-agent-${++seq}`;
  const res = await api(tok[by]!, 'POST', '/v1/agents', { source: source(name, creds, '', owner) });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id, name, creds };
}

/** A new revision of the draft by this user (they become its author). */
async function editDraft(user: string, a: Agent, note: string) {
  const res = await api(tok[user]!, 'PUT', `/v1/agents/${a.id}/draft`, {
    source: source(a.name, a.creds, `\n    # ${note}`),
  });
  expect(res.statusCode, res.body).toBe(200);
}
const devRun = (user: string, a: Agent, payload: Json = { data: { go: true } }) =>
  api(tok[user]!, 'POST', `/v1/agents/${a.id}/dev-runs`, payload);
const running = (runId: string) =>
  n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
const finish = (runId: string) =>
  n.ctx.db
    .update(runs)
    .set({ status: 'succeeded', finishedAt: new Date(), lockedBy: null })
    .where(eq(runs.id, runId));
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
/** Starts a development run of the agent's head revision and asks the broker for the credentials. */
async function devIssue(user: string, a: Agent) {
  const start = await devRun(user, a);
  expect(start.statusCode, start.body).toBe(202);
  const runId = j(start).id as string;
  await running(runId);
  const s = await session(runId);
  const res = await credentials(runId, s.token);
  await finish(runId);
  return { runId, res };
}
const values = (res: { json: () => unknown }) =>
  (j(res) as StepCredentials).credentials.map((c) => c.value);
const auditOf = async (action: string, runId?: string) =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(auditLog.seq))
    .filter((e) => !runId || e.runId === runId)
    .map((e) => e.payload as Json);
const policy = async (patch: Json) => {
  const res = await api(
    tok['dv-root']!,
    'PATCH',
    `/v1/tenants/${id['dv-root']}/settings/agent-lifecycle`,
    patch,
  );
  expect(res.statusCode, res.body).toBe(200);
};
const resetPolicy = () =>
  policy({
    allowDraftRuns: null,
    allowPersonalSecretsInDevRuns: null,
    allowProductionSecretsInDraftRuns: null,
  });

/** An agent version as a publish would store it, with pins we choose (the table is append-only). */
async function forgeVersion(a: Agent, pins: Json[]): Promise<string> {
  const [agent] = await n.ctx.db
    .execute(sql`select draft_source, draft_revision_id from agents where id = ${a.id}`)
    .then((r) => (r as unknown as { rows: Json[] }).rows);
  const { loadAgentDefinition } = await import('@openagentix/core');
  const def = loadAgentDefinition(agent!.draft_source);
  const versionId = randomUUID();
  await n.ctx.db.insert(agentVersions).values({
    id: versionId,
    agentId: a.id,
    version: def.version,
    digest: def.digest,
    source: agent!.draft_source,
    definition: def as unknown as object,
    publishedBy: null,
    revisionId: agent!.draft_revision_id,
    secretResolution: pins as never,
  });
  await n.ctx.db.execute(
    sql`update agents set latest_version_id = ${versionId}, latest_version = ${def.version} where id = ${a.id}`,
  );
  await n.ctx.cache.del(`agent-latest:${a.id}`);
  return versionId;
}

beforeAll(async () => {
  n = await testNode(ENV);
  await mkTenant('dv-root');
  await mkTenant('dv-a', id['dv-root']);
  await mkUser('author', 'dv-a', ['agent-developer']);
  await mkUser('peer', 'dv-a', ['agent-developer']);
  await mkUser('rev', 'dv-a', ['agent-maintainer']);
  await mkUser('viewer', 'dv-a', ['viewer']);
}, 180_000);
afterAll(async () => n?.close());

describe('starting a development run', () => {
  it('runs the head revision as the caller, labelled development, with a frozen definition', async () => {
    const a = await newAgent([]);
    const res = await devRun('author', a);
    expect(res.statusCode, res.body).toBe(202);
    const run = j(res);
    const [revision] = await n.ctx.db
      .execute(sql`select id, seq, digest from agent_draft_revisions where agent_id = ${a.id}`)
      .then((r) => (r as unknown as { rows: Json[] }).rows);
    expect(run).toMatchObject({
      stage: 'development',
      status: 'queued',
      agentVersionId: null,
      agentRevisionId: revision!.id,
      startedBy: uid['author'],
      triggeredBy: `dev:${uid['author']}`,
      agentId: a.id,
    });
    const [def] = await n.ctx.db
      .select()
      .from(devRunDefinitions)
      .where(eq(devRunDefinitions.runId, run.id));
    expect((def!.definition as Json).digest).toBe(revision!.digest);
    expect(await auditOf('run.queued', run.id)).toMatchObject([
      { stage: 'development', revisionId: revision!.id, revisionSeq: revision!.seq },
    ]);
    // the run view and the list say so as well
    const get = await api(tok['author']!, 'GET', `/v1/runs/${run.id}`);
    expect(j(get)).toMatchObject({ stage: 'development', agentVersionId: null });
    await finish(run.id);
  });

  it('keeps executing the revision it was admitted with when the draft changes afterwards', async () => {
    const a = await newAgent([]);
    const start = await devRun('author', a);
    const runId = j(start).id as string;
    const before = (await n.services.control.prepare(runId)).definition;
    const edited = await api(tok['author']!, 'PUT', `/v1/agents/${a.id}/draft`, {
      source: source(a.name, [], '\n    # edited'),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const after = (await n.services.control.prepare(runId)).definition;
    expect(after.digest).toBe(before.digest);
    // a second run of the same agent now runs the new head revision
    const next = await devRun('author', a);
    expect((await n.services.control.prepare(j(next).id)).definition.digest).not.toBe(
      before.digest,
    );
    await finish(runId);
    await finish(j(next).id);
  });

  it('can run an older revision by id, but not a revision of another agent', async () => {
    const a = await newAgent([]);
    const other = await newAgent([]);
    const [first] = await n.ctx.db
      .execute(sql`select id from agent_draft_revisions where agent_id = ${a.id}`)
      .then((r) => (r as unknown as { rows: Json[] }).rows);
    await api(tok['author']!, 'PUT', `/v1/agents/${a.id}/draft`, {
      source: source(a.name, [], '\n    # second'),
    });
    const old = await devRun('author', a, { revisionId: first!.id });
    expect(old.statusCode, old.body).toBe(202);
    expect(j(old).agentRevisionId).toBe(first!.id);
    const [foreign] = await n.ctx.db
      .execute(sql`select id from agent_draft_revisions where agent_id = ${other.id}`)
      .then((r) => (r as unknown as { rows: Json[] }).rows);
    const bad = await devRun('author', a, { revisionId: foreign!.id });
    expect(bad.statusCode).toBe(404);
    await finish(j(old).id);
  });

  it('needs agents:write on the agent, and an agent of another tenant does not exist', async () => {
    const a = await newAgent([]);
    expect((await devRun('viewer', a)).statusCode).toBe(403);
    expect(
      (await api(tok['dv-root']!, 'POST', `/v1/agents/${a.id}/dev-runs`, { data: {} })).statusCode,
    ).toBe(404);
    const ok = await devRun('peer', a);
    expect(ok.statusCode).toBe(202);
    await finish(j(ok).id);
  });

  it('is refused when the lifecycle policy switches draft runs off', async () => {
    const a = await newAgent([]);
    await policy({ allowDraftRuns: 'off' });
    try {
      const res = await devRun('author', a);
      expect(res.statusCode, res.body).toBe(403);
      expect(j(res).error).toBe('draft_runs_disabled');
    } finally {
      await resetPolicy();
    }
    expect((await devRun('author', a)).statusCode).toBe(202);
  });

  it('is refused for a disabled agent and limited to a few active runs per person', async () => {
    const a = await newAgent([]);
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_DEV_RUNS_PER_USER; i++) {
      const r = await devRun('rev', a);
      expect(r.statusCode, r.body).toBe(202);
      ids.push(j(r).id);
    }
    const over = await devRun('rev', a);
    expect(over.statusCode, over.body).toBe(429);
    expect(j(over).error).toBe('dev_run_limit');
    // another person is not affected
    const other = await devRun('author', a);
    expect(other.statusCode).toBe(202);
    await finish(j(other).id);
    // a finished run frees a slot
    await finish(ids[0]!);
    const again = await devRun('rev', a);
    expect(again.statusCode, again.body).toBe(202);
    await finish(j(again).id);
    for (const r of ids.slice(1)) await finish(r);
    await api(tok['dv-a']!, 'POST', `/v1/agents/${a.id}/disable`, { reason: 'test' });
    const disabled = await devRun('author', a);
    expect(disabled.statusCode, disabled.body).toBe(409);
  });
});

describe('a draft cannot be started by an event', () => {
  it('queues production runs only: webhooks and the other triggers name a published version', async () => {
    const a = await newAgent([]);
    // never published: no trigger can run the draft
    const src = await api(tok['dv-a']!, 'POST', '/v1/event-sources', {
      name: `dv-hook-${seq}`,
      kind: 'webhook',
      secretRefs: ['trivy-hook'],
      agentId: a.id,
    });
    expect(src.statusCode, src.body).toBe(201);
    const body = JSON.stringify({ agentRevisionId: randomUUID(), stage: 'development' });
    const post = () =>
      n.req({
        method: 'POST',
        url: `/v1/ingest/webhook/${j(src).id}`,
        token: null,
        payload: body,
        headers: {
          'content-type': 'application/json',
          ...signWebhook('hook-secret-1', body, Math.floor(Date.now() / 1000), randomUUID()),
        },
      });
    const before = await n.ctx.db.select().from(runs).where(eq(runs.agentId, a.id));
    await post();
    expect(await n.ctx.db.select().from(runs).where(eq(runs.agentId, a.id))).toHaveLength(
      before.length,
    );
    await expect(
      n.services.runs.enqueue({
        agentId: a.id,
        event: { specversion: '1.0', id: randomUUID(), source: '/t', type: 'x', data: null },
        triggeredBy: 'cron:nightly',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    // once published, a newer draft revision is still not what an event runs
    await forgeVersion(a, []);
    await api(tok['author']!, 'PUT', `/v1/agents/${a.id}/draft`, {
      source: source(a.name, [], '\n    # newer draft'),
    });
    const hooked = await post();
    expect(hooked.statusCode, hooked.body).toBe(202);
    const run = (
      await n.ctx.db
        .select()
        .from(runs)
        .where(eq(runs.id, j(hooked).runId))
    )[0]!;
    expect(run).toMatchObject({ stage: 'production', agentRevisionId: null, startedBy: null });
    expect(run.agentVersionId).not.toBeNull();
    const direct = await n.services.runs.enqueue({
      agentId: a.id,
      event: { specversion: '1.0', id: randomUUID(), source: '/t', type: 'x', data: null },
      triggeredBy: 'cron:nightly',
    });
    expect(direct.stage).toBe('production');
    expect(direct.startedBy).toBeNull();
  });

  it('is enforced by the database: a run is a production or a development run, never both or neither', async () => {
    const a = await newAgent([]);
    const run = j(await devRun('author', a));
    const [version] = await n.ctx.db
      .insert(agentVersions)
      .values({
        id: randomUUID(),
        agentId: a.id,
        version: '9.9.9',
        digest: 'd'.repeat(64),
        source: 'x',
        definition: {},
        publishedBy: null,
      })
      .returning();
    const bad = (set: string) =>
      n.ctx.db.execute(sql.raw(`update runs set ${set} where id = '${run.id}'`));
    await expect(bad(`stage = 'production'`)).rejects.toThrow();
    await expect(bad(`agent_version_id = '${version!.id}'`)).rejects.toThrow();
    await expect(bad(`started_by = null`)).rejects.toThrow();
    await expect(bad(`agent_revision_id = null`)).rejects.toThrow();
    await finish(run.id);
  });
});

describe('personal secrets in development runs', () => {
  it('issue the value to a development run started by their owner, and redact it', async () => {
    const v = value('mine');
    const sid = await personal('author', 'mine', v);
    const a = await newAgent(['personal:mine']);
    const { runId, res } = await devIssue('author', a);
    expect(res.statusCode, res.body).toBe(200);
    expect(values(res)).toEqual([v]);
    const [issued] = await auditOf('credential.issued', runId);
    expect(issued).toMatchObject({
      stage: 'development',
      secrets: [{ ref: 'personal:mine', scope: 'personal', secretId: sid, ownerNode: id['dv-a'] }],
    });
    // redaction of the issued value, also after the secret is gone
    expect(await n.services.runNodes.knownSecrets(runId)).toContain(v);
    expect(await n.services.runNodes.scrub(runId, { out: `token=${v}` })).toEqual({
      out: expect.not.stringContaining(v),
    });
    await api(tok['author']!, 'DELETE', `/v1/secrets/${sid}`);
    expect(await n.services.runNodes.knownSecrets(runId)).toContain(v);
    expect(JSON.stringify(await n.ctx.db.select().from(auditLog))).not.toContain(v);
  });

  it('are not resolvable by another user: a peer or a reviewer who runs the draft of the author gets nothing', async () => {
    const v = value('only-author');
    await personal('author', 'only-author', v);
    const theirs = value('peer-own');
    await personal('peer', 'only-author', theirs);
    await personal('rev', 'only-author', value('rev-own'));
    const a = await newAgent(['personal:only-author']);
    for (const other of ['peer', 'rev']) {
      const { runId, res } = await devIssue(other, a);
      expect(res.statusCode, `${other}: ${res.body}`).toBe(403);
      expect(res.body).toContain('secret_scope_not_usable');
      expect(res.body).not.toContain(v);
      expect(res.body).not.toContain(theirs);
      expect(await auditOf('secret.access_denied', runId)).toMatchObject([
        { ref: 'personal:only-author', code: 'secret_scope_not_usable', stage: 'development' },
      ]);
    }
    // the author's own run gets the author's secret
    expect(values((await devIssue('author', a)).res)).toEqual([v]);
  });

  it('go to somebody else only after they edited the draft: then the run is theirs and uses their own secret', async () => {
    const v = value('author-secret');
    await personal('author', 'swap', v);
    const theirs = value('reviewer-secret');
    await personal('rev', 'swap', theirs);
    const a = await newAgent(['personal:swap']);
    await editDraft('rev', a, 'reviewer edit');
    const own = await devIssue('rev', a);
    expect(values(own.res)).toEqual([theirs]);
    // the author now runs a revision the reviewer wrote: refused, the reviewer's code gets no credential
    const back = await devIssue('author', a);
    expect(back.res.statusCode).toBe(403);
    expect(back.res.body).not.toContain(v);
  });

  it('are never issued to a run of a published version, whoever starts it', async () => {
    const v = value('prod-denied');
    const sid = await personal('author', 'prod-denied', v);
    const a = await newAgent(['personal:prod-denied']);
    // the publish refuses a personal reference, also for its owner, whatever the policy says
    const pub = await api(tok['rev']!, 'POST', `/v1/agents/${a.id}/publish`);
    expect(pub.statusCode, pub.body).toBe(422);
    expect(j(pub).error).toBe('personal_secret_in_version');
    // a version with a forged pin (the table is append-only; this is a hand-made row): the broker still refuses
    const pin = {
      ref: 'personal:prod-denied',
      state: 'resolved',
      scope: 'personal',
      ownerNode: id['dv-a'],
      secretId: sid,
    };
    await forgeVersion(a, [pin]);
    const manual = await api(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, { data: {} });
    expect(manual.statusCode, manual.body).toBe(202);
    const scheduled = await n.services.runs.enqueue({
      agentId: a.id,
      event: { specversion: '1.0', id: randomUUID(), source: '/t', type: 'x', data: null },
      triggeredBy: 'cron:nightly',
    });
    for (const runId of [j(manual).id as string, scheduled.id]) {
      await running(runId);
      const s = await session(runId);
      const res = await credentials(runId, s.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain('secret_scope_not_usable');
      expect(res.body).not.toContain(v);
      await finish(runId);
    }
  });

  it('are not part of a published version without a pin either', async () => {
    await personal('author', 'unpinned', value('unpinned'));
    const a = await newAgent(['personal:unpinned']);
    await forgeVersion(a, []);
    const run = await n.services.runs.enqueue({
      agentId: a.id,
      event: { specversion: '1.0', id: randomUUID(), source: '/t', type: 'x', data: null },
      triggeredBy: `manual:${uid['author']}`,
    });
    await running(run.id);
    const res = await credentials(run.id, (await session(run.id)).token);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('secret_unavailable');
    await finish(run.id);
  });

  it('need allowPersonalSecretsInDevRuns, and draft runs that are not off', async () => {
    await personal('author', 'policy-gated', value('pg'));
    const a = await newAgent(['personal:policy-gated']);
    await policy({ allowPersonalSecretsInDevRuns: false });
    try {
      const { res } = await devIssue('author', a);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('secret_scope_not_usable');
    } finally {
      await resetPolicy();
    }
    expect((await devIssue('author', a)).res.statusCode).toBe(200);
    // switched off after the run was admitted: the next issuance is refused
    const start = await devRun('author', a);
    const runId = j(start).id as string;
    await running(runId);
    const s = await session(runId);
    await policy({ allowDraftRuns: 'off' });
    try {
      const res = await credentials(runId, s.token);
      expect(res.statusCode).toBe(403);
    } finally {
      await resetPolicy();
      await finish(runId);
    }
  });

  it('stop for a person who lost agents:write (secret_owner_unavailable), and come back with the role', async () => {
    const v = value('role-loss');
    const sid = await personal('peer', 'role-loss', v);
    const a = await newAgent(['personal:role-loss'], 'peer');
    const start = await devRun('peer', a);
    const runId = j(start).id as string;
    await running(runId);
    const nodeValue = value('rln');
    await secret('dv-a', 'role-loss-node', nodeValue);
    const nodeAgent = await newAgent(['tenant:role-loss-node'], 'rev');
    const nodeRun = j(await devRun('peer', nodeAgent)).id as string;
    await running(nodeRun);
    const roleToken = (await session(runId)).token;
    const nodeToken = (await session(nodeRun)).token;
    const patched = await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['peer']}`, {
      globalRoles: ['auditor'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    try {
      const res = await credentials(runId, roleToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain('dev_run_not_permitted');
      expect(res.body).not.toContain(v);
      // the run acts as its starter: secrets of the node are not issued to it either
      const nodeRes = await credentials(nodeRun, nodeToken);
      expect(nodeRes.statusCode, nodeRes.body).toBe(403);
      expect(nodeRes.body).toContain('dev_run_not_permitted');
      expect(nodeRes.body).not.toContain(nodeValue);
      // the broker refuses on its own as well (second wall)
      const row = (await n.ctx.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
      await expect(
        n.services.runNodes.scoped!.prepare(row, ['personal:role-loss'], { destinations: [] }),
      ).rejects.toMatchObject({ code: 'secret_owner_unavailable' });
      // the secret is kept, and its owner can still delete it without the role
      const mine = await n.ctx.db.select().from(secrets).where(eq(secrets.id, sid));
      expect(mine).toHaveLength(1);
    } finally {
      await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['peer']}`, {
        globalRoles: ['agent-developer'],
      });
      await finish(runId);
      await finish(nodeRun);
    }
    expect((await devIssue('peer', a)).res.statusCode).toBe(200);
    await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['peer']}`, { globalRoles: ['auditor'] });
    const del = await api(tok['peer']!, 'DELETE', `/v1/secrets/${sid}`);
    expect(del.statusCode, del.body).toBe(204);
    await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['peer']}`, {
      globalRoles: ['agent-developer'],
    });
  });

  it('are deleted with a disabled account, and its development runs stop', async () => {
    await mkUser('leaver', 'dv-a', ['agent-developer']);
    const v = value('leaver');
    const sid = await personal('leaver', 'leaver-key', v);
    await personal('leaver', 'leaver-key-2', value('leaver2'));
    const a = await newAgent(['personal:leaver-key'], 'leaver');
    const queued = j(await devRun('leaver', a));
    const going = j(await devRun('leaver', a));
    await running(going.id);
    const goingToken = (await session(going.id)).token;
    const off = await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['leaver']}`, { disabled: true });
    expect(off.statusCode, off.body).toBe(200);
    expect(
      await n.ctx.db.select().from(secrets).where(eq(secrets.scopeId, uid['leaver']!)),
    ).toHaveLength(0);
    const deleted = (await auditOf('secret.deleted')).filter((p) => p.reason === 'owner_disabled');
    expect(deleted.map((p) => p.name).sort()).toEqual(['leaver-key', 'leaver-key-2']);
    expect((await n.ctx.db.select().from(runs).where(eq(runs.id, queued.id)))[0]!.status).toBe(
      'cancelled',
    );
    expect(
      (await n.ctx.db.select().from(runs).where(eq(runs.id, going.id)))[0]!.cancelRequested,
    ).toBe(true);
    // nothing is issued from a disabled account, and enabling it again does not restore the secret
    const res = await credentials(going.id, goingToken);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(v);
    await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['leaver']}`, { disabled: false });
    expect(await n.ctx.db.select().from(secrets).where(eq(secrets.id, sid))).toHaveLength(0);
    await finish(going.id);
  });
});

describe('the usage matrix for development runs', () => {
  const issueDev = async (name: string, a?: Agent) =>
    (await devIssue('author', a ?? (await newAgent([`tenant:${name}`])))).res;

  it('issues development and any secrets to a development run, and refuses production ones', async () => {
    const dev = value('u-dev');
    const any = value('u-any');
    await secret('dv-a', 'u-dev', dev, { usage: 'development' });
    await secret('dv-a', 'u-any', any, { usage: 'any' });
    await secret('dv-a', 'u-prod', value('u-prod'), { usage: 'production' });
    expect(values(await issueDev('u-dev'))).toEqual([dev]);
    expect(values(await issueDev('u-any'))).toEqual([any]);
    const denied = await issueDev('u-prod');
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain('secret_not_usable');
  });

  it('lets drafts use production secrets only with draft runs "on" and the flag', async () => {
    const v = value('u-prod-flag');
    await secret('dv-a', 'u-prod-flag', v, { usage: 'production' });
    const a = await newAgent(['tenant:u-prod-flag']);
    try {
      await policy({ allowProductionSecretsInDraftRuns: true });
      expect((await devIssue('author', a)).res.statusCode).toBe(403);
      await policy({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: false });
      expect((await devIssue('author', a)).res.statusCode).toBe(403);
      await policy({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true });
      expect(values((await devIssue('author', a)).res)).toEqual([v]);
    } finally {
      await resetPolicy();
    }
  });

  it('applies the usage of a personal secret as well', async () => {
    await personal('author', 'p-prod', value('p-prod'), { usage: 'production' });
    const a = await newAgent(['personal:p-prod']);
    const { res } = await devIssue('author', a);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('secret_not_usable');
  });

  it('never issues a development secret to a run of a published version', async () => {
    const sid = await secret('dv-a', 'u-dev-prod', value('u-dev-prod'), { usage: 'development' });
    const a = await newAgent(['tenant:u-dev-prod']);
    const pub = await api(tok['rev']!, 'POST', `/v1/agents/${a.id}/publish`);
    expect(pub.statusCode, pub.body).toBe(422);
    expect(j(pub).details.references[0].reason).toBe('usage');
    const pin = {
      ref: 'tenant:u-dev-prod',
      state: 'resolved',
      scope: 'tenant',
      ownerNode: id['dv-a'],
      secretId: sid,
    };
    await forgeVersion(a, [pin]);
    const run = await n.services.runs.enqueue({
      agentId: a.id,
      event: { specversion: '1.0', id: randomUUID(), source: '/t', type: 'x', data: null },
      triggeredBy: 'cron:nightly',
    });
    await running(run.id);
    const res = await credentials(run.id, (await session(run.id)).token);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('secret_not_usable');
    await finish(run.id);
  });
});

describe('secrets of a higher node in a draft (foreign secrets)', () => {
  it('are refused unless their owner marked them usage development; the node own secrets are fine', async () => {
    const any = value('f-any');
    const dev = value('f-dev');
    await secret('dv-root', 'f-any', any, { usage: 'any', allowOverride: true });
    await secret('dv-root', 'f-dev', dev, { usage: 'development' });
    await secret('dv-root', 'f-prod', value('f-prod'), { usage: 'production' });
    const denied = await devIssue('author', await newAgent(['tenant:f-any']));
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toContain('secret_scope_not_usable');
    expect(denied.res.body).not.toContain(any);
    const prod = await devIssue('author', await newAgent(['tenant:f-prod']));
    expect(prod.res.body).toContain('secret_scope_not_usable');
    expect(values((await devIssue('author', await newAgent(['tenant:f-dev']))).res)).toEqual([dev]);
    // the same name owned by the node itself resolves to the node's own secret (nearest wins)
    const own = value('f-own');
    await secret('dv-a', 'f-any', own, { usage: 'any' });
    expect(values((await devIssue('author', await newAgent(['tenant:f-any']))).res)).toEqual([own]);
  });

  it('are audited with the owning node when issued', async () => {
    await secret('dv-root', 'f-audit', value('f-audit'), { usage: 'development' });
    const { runId, res } = await devIssue('author', await newAgent(['tenant:f-audit']));
    expect(res.statusCode).toBe(200);
    const [issued] = await auditOf('credential.issued', runId);
    expect(issued).toMatchObject({
      stage: 'development',
      secrets: [{ ref: 'tenant:f-audit', ownerNode: id['dv-root'] }],
    });
  });
});

describe('side effects and bookkeeping', () => {
  it('labels the run in the audit when it completes and in the costs export', async () => {
    const a = await newAgent([]);
    const run = j(await devRun('author', a));
    await n.services.control.completeRun(run.id, {
      status: 'succeeded',
      outputs: [],
      usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
    } as never);
    expect(await auditOf('run.completed', run.id)).toMatchObject([{ stage: 'development' }]);
  });

  it('keeps the credentials of two development runs of different people apart', async () => {
    const mine = value('apart-a');
    const theirs = value('apart-b');
    await personal('author', 'apart', mine);
    await personal('peer', 'apart', theirs);
    const a = await newAgent(['personal:apart']);
    const first = j(await devRun('author', a));
    await running(first.id);
    expect(values(await credentials(first.id, (await session(first.id)).token))).toEqual([mine]);
    await finish(first.id);
    await editDraft('peer', a, 'peer edit');
    const second = j(await devRun('peer', a));
    await running(second.id);
    expect(values(await credentials(second.id, (await session(second.id)).token))).toEqual([
      theirs,
    ]);
    await finish(second.id);
  });
});

describe('who may start a development run (resource-scoped access)', () => {
  it('needs agents:write on the team of the agent, not just somewhere', async () => {
    await mkUser('teamer', 'dv-a', ['viewer']);
    const mkTeam = async (slug: string) => {
      const res = await api(tok['dv-a']!, 'POST', '/v1/teams', { slug, name: slug });
      expect(res.statusCode, res.body).toBe(201);
      return j(res).id as string;
    };
    const teamA = await mkTeam('dv-team-a');
    await mkTeam('dv-team-b');
    const put = await api(tok['dv-a']!, 'PUT', `/v1/teams/${teamA}/members`, {
      members: [{ userId: uid['teamer'], role: 'agent-developer' }],
    });
    expect(put.statusCode, put.body).toBe(204);
    tok['teamer'] = await n.login('teamer@dv.example.org', PW);
    const inA = await newAgent([], 'dv-a', 'dv-team-a');
    const inB = await newAgent([], 'dv-a', 'dv-team-b');
    // the agent of the other team is readable but not writable for this person
    const denied = await devRun('teamer', inB);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await n.ctx.db.select().from(runs).where(eq(runs.agentId, inB.id))).toHaveLength(0);
    const ok = await devRun('teamer', inA);
    expect(ok.statusCode, ok.body).toBe(202);
    await finish(j(ok).id);
  });
});

describe('a development run stops when its starter or the policy changes', () => {
  const reserve = (runId: string) =>
    n.services.modelAccounting.reserve(
      { tenantId: id['dv-a']! },
      { runId, agentId: 'research', inputTokens: 10, maxOutputTokens: 10 },
    );
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: { code?: string }) => e.code,
    );

  it('refuses a claim and a model reservation after the starter lost agents:write, and cancels queued runs', async () => {
    await mkUser('roler', 'dv-a', ['agent-developer']);
    const a = await newAgent([], 'roler');
    const queued = j(await devRun('roler', a)).id as string;
    const going = j(await devRun('roler', a)).id as string;
    await running(going);
    expect(await code(n.services.control.prepare(going))).toBeUndefined();
    const patched = await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['roler']}`, {
      globalRoles: ['auditor'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await code(n.services.control.prepare(going))).toBe('dev_run_not_permitted');
    expect(await code(reserve(going))).toBe('dev_run_not_permitted');
    expect(await code(session(going))).toBe('dev_run_not_permitted');
    expect((await n.ctx.db.select().from(runs).where(eq(runs.id, queued)))[0]!.status).toBe(
      'cancelled',
    );
    await finish(going);
  });

  it('refuses a claim, a reservation and a session once the policy switches draft runs off', async () => {
    const a = await newAgent([]);
    const runId = j(await devRun('author', a)).id as string;
    await running(runId);
    await policy({ allowDraftRuns: 'off' });
    try {
      expect(await code(n.services.control.prepare(runId))).toBe('dev_run_not_permitted');
      expect(await code(reserve(runId))).toBe('dev_run_not_permitted');
      expect(await code(session(runId))).toBe('dev_run_not_permitted');
    } finally {
      await resetPolicy();
      await finish(runId);
    }
  });

  it('does not admit a run for an account that was disabled after the request was authenticated', async () => {
    await mkUser('ghost', 'dv-a', ['agent-developer']);
    const a = await newAgent([], 'ghost');
    const principal = await n.services.identity.principalForUser(uid['ghost']!);
    await api(tok['dv-a']!, 'PATCH', `/v1/users/${uid['ghost']}`, { disabled: true });
    expect(await code(n.services.devRuns.start(principal, a.id, {}))).toBe('dev_run_not_permitted');
    expect(await n.ctx.db.select().from(runs).where(eq(runs.agentId, a.id))).toHaveLength(0);
  });
});

describe('credentials that are not scoped secrets count as production credentials', () => {
  const legacyAgent = () => newAgent(['plain-legacy-ref']);

  it('refuses a draft that references an operator secret, unless drafts may use production credentials', async () => {
    const a = await legacyAgent();
    const res = await devRun('author', a);
    expect(res.statusCode, res.body).toBe(400);
    expect(j(res)).toMatchObject({
      error: 'production_credentials_in_draft',
      details: { legacyReferences: ['plain-legacy-ref'] },
    });
    try {
      await policy({ allowProductionSecretsInDraftRuns: true });
      expect((await devRun('author', a)).statusCode).toBe(400);
      await policy({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true });
      const ok = await devRun('author', a);
      expect(ok.statusCode, ok.body).toBe(202);
      await finish(j(ok).id);
    } finally {
      await resetPolicy();
    }
  });

  it('refuses to issue a legacy reference to a run admitted under a looser policy, and audits it', async () => {
    const a = await legacyAgent();
    await policy({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true });
    let runId: string;
    try {
      runId = j(await devRun('author', a)).id as string;
    } finally {
      await resetPolicy();
    }
    await running(runId);
    const res = await credentials(runId, (await session(runId)).token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('production_credentials_in_draft');
    expect(await auditOf('secret.access_denied', runId)).toMatchObject([
      { ref: 'plain-legacy-ref', code: 'production_credentials_in_draft', stage: 'development' },
    ]);
    await finish(runId);
  });
});

describe('approvals of a development run', () => {
  const approvalFor = async (runId: string) => {
    const approvalId = await n.services.control.requestApproval(
      runId,
      'research',
      { server: 'jira', tool: 'write_issue', args: { a: 1 } },
      [],
    );
    const [row] = await n.ctx.db
      .execute(sql`select approver_roles from approvals where id = ${approvalId}`)
      .then((r) => (r as unknown as { rows: Json[] }).rows);
    return { approvalId, roles: row!.approver_roles as string[] };
  };
  const decide = (user: string, approvalId: string) =>
    api(tok[user]!, 'POST', `/v1/approvals/${approvalId}/decision`, { decision: 'approve' });

  it('use the default approver roles whatever the draft says, and the starter cannot approve their own run', async () => {
    await mkUser('adm2', 'dv-a', ['admin']);
    const a = await newAgent([], 'adm2');
    // the draft asks for its own approvers
    const edit = await api(tok['adm2']!, 'PUT', `/v1/agents/${a.id}/draft`, {
      source: source(a.name, [], '').replace(
        'budget:',
        'approvals: { approverRoles: [agent-developer], timeoutSeconds: 600 }\nbudget:',
      ),
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const runId = j(await devRun('adm2', a)).id as string;
    await running(runId);
    const { approvalId, roles } = await approvalFor(runId);
    expect(roles.sort()).toEqual(['admin', 'operator']);
    const self = await decide('adm2', approvalId);
    expect(self.statusCode, self.body).toBe(403);
    expect(j(self).error).toBe('self_approval');
    // somebody else with an approver role can
    const other = await decide('dv-a', approvalId);
    expect(other.statusCode, other.body).toBe(200);
    await finish(runId);
  });
});

describe('who can see a development run', () => {
  it('shows it to its starter and to node administrators, not to other readers', async () => {
    const a = await newAgent([]);
    const runId = j(await devRun('author', a)).id as string;
    const get = (user: string) => api(tok[user]!, 'GET', `/v1/runs/${runId}`);
    // sanity: the same reader can read an ordinary run of that agent
    await forgeVersion(a, []);
    const prod = j(await api(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, { data: {} })).id;
    expect((await api(tok['peer']!, 'GET', `/v1/runs/${prod}`)).statusCode).toBe(200);
    expect((await get('author')).statusCode).toBe(200);
    expect((await get('dv-a')).statusCode).toBe(200);
    expect((await get('peer')).statusCode).toBe(404);
    expect((await get('rev')).statusCode).toBe(404);
    const ids = async (user: string) =>
      ((await api(tok[user]!, 'GET', `/v1/runs?agentId=${a.id}`)).json().items as Json[]).map(
        (r) => r.id,
      );
    expect(await ids('author')).toContain(runId);
    expect(await ids('dv-a')).toContain(runId);
    expect(await ids('peer')).not.toContain(runId);
    expect((await api(tok['peer']!, 'GET', `/v1/runs/${runId}/steps`)).statusCode).toBe(404);
    await finish(runId);
  });
});

describe('approvals of a development run are not for every reader', () => {
  it('shows them to the starter, to administrators and to approvers, not to other readers', async () => {
    await mkUser('oper', 'dv-a', ['operator']);
    const a = await newAgent([]);
    const runId = j(await devRun('author', a)).id as string;
    await running(runId);
    const approvalId = await n.services.control.requestApproval(
      runId,
      'research',
      { server: 'jira', tool: 'write_issue', args: { secret: 'derived-from-personal-credential' } },
      [],
    );
    const seen = async (user: string) =>
      ((await api(tok[user]!, 'GET', '/v1/approvals')).json().items as Json[]).map((r) => r.id);
    expect(await seen('author')).toContain(approvalId);
    expect(await seen('dv-a')).toContain(approvalId);
    expect(await seen('oper')).toContain(approvalId);
    for (const reader of ['viewer', 'peer', 'rev']) {
      const list = await api(tok[reader]!, 'GET', '/v1/approvals');
      expect(list.statusCode, reader).toBe(200);
      expect(list.body, reader).not.toContain('derived-from-personal-credential');
      expect(await seen(reader), reader).not.toContain(approvalId);
    }
    await finish(runId);
  });
});
