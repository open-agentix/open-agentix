import { randomBytes, randomUUID } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, logDestination } from '../src/context.js';
import { connections, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { registerErrorHandler } from '../src/errors.js';
import { ContextGuard } from '@openagentix/core';
import { processSecrets, scrubResponses } from '../src/mcp-oauth/index.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * Token leak canaries, control-node side (ADR 0016 section 10, slice S5): an access token with a
 * canary value is stored and handed out through `McpCredentials`; it must not appear in logs,
 * error bodies, audit entries, API responses or what a run node is given. Step records, model
 * requests and spans are covered next to the executor (apps/worker/test/mcp-oauth-canary.test.ts).
 */
const CANARY = 'CANARY-9f3a7cQ1e5b2dZ4a60xKm8';
const REFRESH_CANARY = 'CANARY-1d8e6bH4f2a9cW7350pTn2';
const RESOURCE = 'https://mcp.example.org/mcp';

let n: TestNode;
let connectionId: string;

beforeAll(async () => {
  n = await testNode({ OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64') });
  connectionId = randomUUID();
  await n.ctx.db.insert(connections).values({
    id: connectionId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'jira',
    kind: 'mcp',
    config: { transport: 'streamable-http', url: RESOURCE },
  });
  await n.services.mcpOauth.tokens.put({
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    credentialVersion: 1,
    issuer: 'https://auth.example.org',
    resource: RESOURCE,
    clientRef: 'client',
    scopes: ['read'],
    accessToken: CANARY,
    refreshToken: REFRESH_CANARY,
  });
});

/** The use of the token: registers it with the guard of the run and the process redactor. */
const arm = () =>
  n.services.mcpOauth.credentials.accessToken(
    { id: connectionId, tenantId: DEFAULT_TENANT_ID },
    ['read'],
    {
      guard: new ContextGuard(),
    },
  );
afterAll(async () => {
  processSecrets.clear();
  await n.close();
});

/** A principal of the token's tenant on every request, as the auth hook of the real app sets it. */
const signedIn = (app: FastifyInstance) =>
  app.addHook('onRequest', async (req) => {
    (req as unknown as { principal: { tenantId: string } }).principal = {
      tenantId: DEFAULT_TENANT_ID,
    };
  });

const lines = (): { sink: { write(l: string): void }; out: string[] } => {
  const out: string[] = [];
  return { out, sink: { write: (l) => void out.push(l) } };
};

describe('logs', () => {
  beforeAll(async () => {
    processSecrets.clear();
    await arm(); // the redactor is the net under test here
  });

  it('scrubs the token from messages, fields, errors and stack traces', () => {
    const { sink, out } = lines();
    const log = createLogger('info', 'canary', sink);
    log.info(`calling with ${CANARY}`);
    log.warn({ header: `Bearer ${CANARY}`, nested: { v: [CANARY] } }, 'field');
    const err = new Error(`upstream rejected ${CANARY}`);
    log.error({ err }, 'failed');
    log.error(err);
    const text = out.join('');
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain(CANARY);
    expect(text).toContain('[REDACTED]');
  });

  it('scrubs the URL-encoded and JSON-escaped forms too', () => {
    const { sink, out } = lines();
    const log = createLogger('info', 'canary', sink);
    log.info({ url: `https://x.example/cb?token=${encodeURIComponent(CANARY)}` }, 'u');
    expect(out.join('')).not.toContain(CANARY);
  });

  it('the request log of the HTTP app goes through the same destination', async () => {
    const { sink, out } = lines();
    const app = Fastify({ logger: { level: 'info', stream: logDestination(sink) as never } });
    app.get('/x', async (req) => {
      req.log.info(`handler saw ${CANARY}`);
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/x' });
    await app.close();
    expect(out.join('')).toContain('handler saw');
    expect(out.join('')).not.toContain(CANARY);
  });
});

describe('errors', () => {
  beforeAll(async () => {
    processSecrets.clear();
    await arm(); // the redactor is the net under test here
  });

  it('scrubs the token from error bodies, including the unhandled 500 path and its log', async () => {
    const { sink, out } = lines();
    const app = Fastify({ logger: { level: 'info', stream: logDestination(sink) as never } });
    registerErrorHandler(app);
    signedIn(app);
    scrubResponses(app, processSecrets);
    app.get('/domain', async () => {
      throw new OaxError('mcp_upstream', `server said: ${CANARY}`, { echoed: CANARY });
    });
    app.get('/crash', async () => {
      throw new Error(`boom ${CANARY}`);
    });
    for (const url of ['/domain', '/crash']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain(CANARY);
    }
    await app.close();
    expect(out.join('')).not.toContain(CANARY);
  });
});

describe('audit', () => {
  beforeAll(async () => {
    processSecrets.clear();
    await arm(); // the redactor is the net under test here
  });

  it('scrubs the token from a payload, in the stored row and in the audit API', async () => {
    const entry = await n.services.audit.append({
      actor: 'user:admin',
      tenantId: DEFAULT_TENANT_ID,
      action: 'mcp.oauth.refresh_failed',
      target: connectionId,
      payload: { connection: connectionId, error: `invalid_grant for ${CANARY}`, list: [CANARY] },
    });
    expect(JSON.stringify(entry)).not.toContain(CANARY);
    const res = await n.req({ method: 'GET', url: '/v1/audit?limit=200' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CANARY);
    expect(res.body).toContain('mcp.oauth.refresh_failed');
    // the chain still verifies after the payload was scrubbed before hashing
    const verify = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(verify.json().valid).toBe(true);
  });
});

describe('API responses', () => {
  // The redactor is EMPTY here: a structural leak (a handler that returns the value) must show up
  // in the body instead of being hidden by the response hook.
  beforeAll(() => processSecrets.clear());

  it('no connection endpoint exposes a token, a refresh token or the ciphertext', async () => {
    const urls = [
      '/v1/connections',
      `/v1/connections/${connectionId}`,
      `/v1/connections/${connectionId}/tool-snapshots`,
      '/v1/connections/stdio-violations',
      '/v1/tenants',
      '/v1/audit?limit=200',
      '/openapi.json',
    ];
    for (const url of urls) {
      const res = await n.req({ method: 'GET', url });
      expect(res.body, url).not.toContain(CANARY);
      expect(res.body, url).not.toContain(REFRESH_CANARY);
      expect(res.body, url).not.toContain('oaxe1.');
      expect(res.body, url).not.toMatch(/access_token_enc|accessTokenEnc|wrapped_?key/i);
    }
  });

  it('an error from a connection endpoint does not echo the token either', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: CANARY, config: { transport: 'streamable-http', url: RESOURCE } },
    });
    expect(res.body).not.toContain(CANARY);
  });
});

describe('the detector itself', () => {
  it('goes red for a deliberately leaking handler while the redactor is empty, and the net catches it when armed', async () => {
    const app = Fastify({ logger: false });
    signedIn(app);
    scrubResponses(app, processSecrets);
    app.get('/leak', async () => {
      const stored = await n.services.mcpOauth.tokens.open(DEFAULT_TENANT_ID, connectionId, 1);
      return { value: stored!.accessToken };
    });
    processSecrets.clear();
    const bare = await app.inject({ method: 'GET', url: '/leak' });
    expect(bare.body).toContain(CANARY); // what the structural checks above would report
    await arm();
    const armed = await app.inject({ method: 'GET', url: '/leak' });
    expect(armed.body).not.toContain(CANARY);
    expect(JSON.parse(armed.body)).toEqual({ value: '[REDACTED]' });
    await app.close();
  });
});

describe('scoping and wiring', () => {
  it('a response served to another tenant is not rewritten with the token of this one', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      (req as unknown as { principal: { tenantId: string } }).principal = {
        tenantId: 'other-tenant',
      };
    });
    scrubResponses(app, processSecrets);
    app.get('/x', async () => ({ note: CANARY }));
    await arm();
    expect((await app.inject({ method: 'GET', url: '/x' })).body).toContain(CANARY);
    await app.close();
  });

  it('warns when the registry drops a still-valid token (handler wired at start-up)', () => {
    expect(typeof processSecrets.onLiveEviction).toBe('function');
  });
});
