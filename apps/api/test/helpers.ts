import { randomUUID } from 'node:crypto';
import { StaticSecretResolver, loadAgentDefinition } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { FetchFn } from '@openagentix/runners';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { agentReviews, agentVersions, agents } from '../src/db/schema.js';
import { createControlNode, loadConfig, type AppContext, type ControlNode } from '../src/index.js';

export const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };
export const RUN_TOKEN_SECRET = 'r'.repeat(40);

export const testSecrets = new StaticSecretResolver({
  'trivy-hook': 'hook-secret-1',
  'mail-hook': 'mail-secret-1',
  'gh-hook': 'gh-secret',
});

export interface TestNode extends ControlNode {
  admin: string;
  req: (opts: InjectOptions & { token?: string | null }) => Promise<LightMyRequestResponse>;
  login: (email: string, password: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function testNode(
  env: Record<string, string> = {},
  overrides: Partial<AppContext> = {},
): Promise<TestNode> {
  const config = loadConfig({
    NODE_ENV: 'test',
    OAX_DATABASE_URL: 'memory://',
    OAX_LOG_LEVEL: 'silent',
    OAX_BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
    OAX_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    OAX_RUN_TOKEN_SECRET: RUN_TOKEN_SECRET,
    OAX_APPROVAL_POLL_MS: '20',
    OAX_SSE_POLL_MS: '20',
    OAX_RATE_LIMIT_MAX: '10000',
    // Approval at publish is enforced (ADR 0017 S3) and `auto` turns it on as soon as there are two
    // tenants: tests that are not about approval would be unable to publish. Tests of the gate set it.
    OAX_LIFECYCLE_REQUIRE_APPROVAL: 'off',
    // Re-runs the whole suite on the resolver path: OAX_TEST_ROLE_BINDINGS_READ=bindings (ADR 0014 S2).
    ...(process.env.OAX_TEST_ROLE_BINDINGS_READ
      ? { OAX_ROLE_BINDINGS_READ: process.env.OAX_TEST_ROLE_BINDINGS_READ }
      : {}),
    ...env,
  });
  const node = await createControlNode(config, { secrets: testSecrets, ...overrides });
  const login = async (email: string, password: string) => {
    const res = await node.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: email, password },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    return (res.json() as { token: string }).token;
  };
  const admin = await login(ADMIN.email, ADMIN.password);
  const req: TestNode['req'] = ({ token, ...opts }) => {
    const t = token === undefined ? admin : token;
    return node.app.inject({
      ...opts,
      headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...opts.headers },
    });
  };
  return {
    ...node,
    admin,
    req,
    login,
    close: async () => {
      await node.app.close();
      await node.ctx.database.close();
    },
  };
}

/** A `fetch` that talks to an in-process app (for HttpControlPlane in tests). */
export function injectFetch(app: FastifyInstance): FetchFn {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers: init?.headers as Record<string, string>,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    });
  };
}

/**
 * Inserts a published version row for an agent the way a publish does (revision, definition,
 * latest version), without the approval gate: a fixture for tests that need a base version while
 * approval is on. The code path under test never uses it. `setLatest: false` adds a version that
 * the agent does not point to (a version of a review that is finished only for the test).
 */
export async function insertVersion(
  n: TestNode,
  agentId: string,
  opts: { version?: string; setLatest?: boolean; reviewId?: string } = {},
): Promise<string> {
  const [agent] = await n.ctx.db.select().from(agents).where(eq(agents.id, agentId));
  // Fixtures of other tests store sources that are not valid agents.md files.
  const def = (() => {
    try {
      return loadAgentDefinition(agent!.draftSource);
    } catch {
      return { version: '0.0.0', digest: randomUUID().replaceAll('-', '').repeat(2) };
    }
  })();
  const id = randomUUID();
  const approved = opts.reviewId ? { reviewId: opts.reviewId, approvedBy: [randomUUID()] } : {};
  await n.ctx.db.insert(agentVersions).values({
    id,
    agentId,
    version: opts.version ?? def.version,
    digest: opts.version ? randomUUID().replaceAll('-', '').repeat(2) : def.digest,
    source: agent!.draftSource,
    definition: def as unknown as object,
    publishedBy: null,
    revisionId: agent!.draftRevisionId,
    ...approved,
  });
  if (opts.setLatest !== false)
    await n.ctx.db
      .update(agents)
      .set({ latestVersionId: id, latestVersion: opts.version ?? def.version })
      .where(eq(agents.id, agentId));
  return id;
}

/** Ends an open review as `published` the way the database requires: with the version it ended in. */
export async function settleReviewPublished(n: TestNode, reviewId: string): Promise<void> {
  const [review] = await n.ctx.db.select().from(agentReviews).where(eq(agentReviews.id, reviewId));
  const versionId = await insertVersion(n, review!.agentId, {
    version: `settled-${randomUUID()}`,
    setLatest: false,
  });
  await n.ctx.db
    .update(agentReviews)
    .set({ status: 'published', closedAt: new Date(), publishedVersionId: versionId })
    .where(eq(agentReviews.id, reviewId));
}
