import { StaticSecretResolver } from '@openagentix/core';
import type { FetchFn } from '@openagentix/runners';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
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
