import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPullRequestDelivery,
  deliveryAuditSink,
  platformSecretValues,
} from '../src/pr-wiring.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'oax-wiring-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ctx = {
  secrets: { resolve: async () => 'secret-value-123456' },
  config: {
    runToken: { secret: 'run-token-signing-secret-xyz' },
    database: { password: 'db-password-123' },
    auth: {
      bootstrapAdmin: { password: 'admin-password-123' },
      oidc: null,
      ldap: { bindPassword: 'ldap-bind-secret-1' },
    },
    runners: { container: { config: { egressGrantSecret: 'grant-secret-abcdefghij' } } },
  },
} as never;
const services = (resolved: string[] = ['brokered-secret-value']) =>
  ({
    runNodes: {
      knownSecrets: async () => resolved,
      platformSecretRefs: async () => new Set(['provider-key']),
    },
    audit: { append: async () => undefined },
  }) as never;

describe('pull request wiring', () => {
  it('is off without OAX_PR_TARGETS', () => {
    expect(createPullRequestDelivery(ctx, services(), 'w1', {})).toBeUndefined();
  });

  it('builds the delivery from the target file', () => {
    const f = path.join(dir, 'targets.json');
    writeFileSync(
      f,
      JSON.stringify([
        {
          name: 'dogfood-sandbox',
          url: 'https://github.com/open-agentix/dogfood-sandbox',
          tokenRef: 'git-token',
        },
      ]),
    );
    const d = createPullRequestDelivery(ctx, services(), 'w1', {
      OAX_PR_TARGETS: f,
      OAX_PR_DRY_RUN: 'true',
      OAX_PR_PRIVATE_ALLOW: 'git.example.org, 10.0.0.0/8',
    });
    expect(d?.has('dogfood-sandbox')).toBe(true);
    expect(d?.has('other')).toBe(false);
  });

  it('refuses a missing or invalid target file (fail closed at start-up)', () => {
    expect(() =>
      createPullRequestDelivery(ctx, services(), 'w1', {
        OAX_PR_TARGETS: path.join(dir, 'nope.json'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'target_invalid' }));
    const f = path.join(dir, 'bad.json');
    writeFileSync(f, '[{"name":"x"}]');
    expect(() =>
      createPullRequestDelivery(ctx, services(), 'w1', { OAX_PR_TARGETS: f }),
    ).toThrowError(expect.objectContaining({ code: 'target_invalid' }));
  });

  it('collects the platform secrets worth keeping out of a pull request', () => {
    expect(platformSecretValues((ctx as { config: never }).config)).toEqual([
      'run-token-signing-secret-xyz',
      'db-password-123',
      'admin-password-123',
      'ldap-bind-secret-1',
      'grant-secret-abcdefghij',
    ]);
    expect(platformSecretValues({ runToken: { secret: 'short' }, database: {} } as never)).toEqual(
      [],
    );
  });

  it('writes delivery events to the audit chain of the run, without the time field', async () => {
    const seen: unknown[] = [];
    const sink = deliveryAuditSink(
      { audit: { append: async (e: unknown) => void seen.push(e) } } as never,
      'w9',
    );
    await sink({
      action: 'pull_request.opened',
      runId: 'r1',
      target: 'dogfood-sandbox',
      at: '2026-10-09T00:00:00Z',
      number: 5,
    });
    expect(seen).toEqual([
      {
        actor: 'worker:w9',
        action: 'pull_request.opened',
        target: 'dogfood-sandbox',
        runId: 'r1',
        payload: { number: 5 },
      },
    ]);
  });
});
