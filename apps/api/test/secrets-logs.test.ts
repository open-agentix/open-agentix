import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/context.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * No secret value reaches a log line: not on success, not on a refusal, and not when a database
 * statement that carries the value fails (the driver puts the bound parameters into its error).
 */
const PW = 'long-password-123';
let n: TestNode;
let out = '';
let token: string;

beforeAll(async () => {
  n = await testNode(
    { OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64') },
    {
      logger: createLogger('trace', 'secrets-logs-test', {
        write(line: string) {
          out += line;
        },
      }),
    },
  );
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug: 'log-org',
      name: 'log-org',
      admin: { email: 'admin@log-org.example.org', displayName: 'a', password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  token = await n.login('admin@log-org.example.org', PW);
}, 120_000);
afterAll(async () => n?.close());

const post = (url: string, payload: object) => n.req({ method: 'POST', url, token, payload });

describe('logging', () => {
  it('never writes a value, on success, on refusal or on a failing statement', async () => {
    const canaries = [
      'log-canary-1-' + randomBytes(5).toString('hex'),
      'log-canary-2-' + randomBytes(5).toString('hex'),
    ];
    const made = await post('/v1/secrets', { scope: 'tenant', name: 'logged', value: canaries[0] });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    await post(`/v1/secrets/${id}/rotate`, { value: canaries[1] });
    // refusals: too short, duplicate name, unknown field
    await post('/v1/secrets', { scope: 'tenant', name: 'logged', value: canaries[0] });
    await post('/v1/secrets', { scope: 'tenant', name: 'short', value: 'abc' });
    await post('/v1/secrets', {
      scope: 'tenant',
      name: 'extra',
      value: canaries[0],
      secret: canaries[1],
    });
    // an unexpected failure of the insert that carries the value as a bound parameter
    const store = (
      n.services.secrets as unknown as { store: { put: (...a: unknown[]) => Promise<void> } }
    ).store;
    const spy = vi
      .spyOn(store, 'put')
      .mockRejectedValueOnce(
        new DrizzleQueryError(
          'insert into "secret_versions" ("ciphertext") values ($1)',
          [canaries[0]],
          new Error('boom'),
        ),
      );
    const failed = await post('/v1/secrets', { scope: 'tenant', name: 'boom', value: canaries[0] });
    spy.mockRestore();
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain(canaries[0]);
    await n.req({ method: 'POST', url: `/v1/secrets/${id}/revoke`, token });
    await n.req({ method: 'DELETE', url: `/v1/secrets/${id}`, token });
    expect(out.length).toBeGreaterThan(0);
    for (const c of canaries) expect(out).not.toContain(c);
  });
});
