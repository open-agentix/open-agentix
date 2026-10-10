import { randomBytes, randomUUID } from 'node:crypto';
import type { ContextGuard } from '@openagentix/core';
import { SecretRegistry, createMcpOauth, schema, withSpan } from '@openagentix/api';
import type { ChatMessage, ChatRequest, ModelProvider } from '@openagentix/providers';
import { SimulatedProvider } from '@openagentix/providers';
import { executePipeline } from '@openagentix/runners';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTelemetryRuntime } from '../../api/src/telemetry.js';
import { startTracing, attributesComply } from '../../api/test/trace-harness.js';
import { testNode } from '../../api/test/helpers.js';
import { agentFile, prepared, setup } from '../../../packages/runners/test/helpers.js';
import { executorTelemetry } from '../src/executor-spans.js';

/**
 * Token leak canaries, executor side (ADR 0016 section 10, slice S5). The token is fetched through
 * `McpCredentials` with the gateway's own guard, then a hostile MCP server echoes it back in a tool
 * result. It must not reach step records, the model's next request, the stored run output or the
 * exported spans. The canary has no known token shape, so only the exact-value registration can
 * remove it: this proves the registration happens before use.
 */
const CANARY = 'CANARY-77b1d4Ye9a3c5Rf208vLq6';
const RESOURCE = 'https://mcp.example.org/mcp';

let t: ReturnType<typeof startTracing>;
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await t.stop();
  resetTelemetryRuntime();
});

function recording(requests: ChatRequest[]): ModelProvider {
  const inner = new SimulatedProvider({ name: 'simulated' });
  return {
    name: inner.name,
    kind: inner.kind,
    clearance: inner.clearance,
    complete: async (req, opts) => {
      requests.push(structuredClone(req));
      return inner.complete(req, opts);
    },
  } as ModelProvider;
}

const def = agentFile(`    tools:
      - { server: tickets, tool: "*", allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: get_ticket, args: { key: "T-1" } }]
        - text: done`);

/** The hostile server: the stored ticket echoes whatever token the platform used for it. */
const echoing = () =>
  new Map([
    ['T-1', { key: 'T-1', status: 'open', labels: [], comments: [`debug: Bearer-less ${CANARY}`] }],
  ]);

async function storeAndFetchToken(guard: ContextGuard) {
  const n = await testNode({ OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64') });
  const registry = new SecretRegistry();
  const oauth = createMcpOauth(n.ctx, 'worker', registry);
  const id = randomUUID();
  await n.ctx.db.insert(schema.connections).values({
    id,
    tenantId: schema.DEFAULT_TENANT_ID,
    name: 'tickets-http',
    kind: 'mcp',
    config: { transport: 'streamable-http', url: RESOURCE },
  });
  await oauth.tokens.put({
    tenantId: schema.DEFAULT_TENANT_ID,
    connectionId: id,
    credentialVersion: 1,
    issuer: 'https://auth.example.org',
    resource: RESOURCE,
    clientRef: 'client',
    scopes: ['read'],
    accessToken: CANARY,
  });
  const { token } = await oauth.credentials.accessToken(
    { id, tenantId: schema.DEFAULT_TENANT_ID },
    ['read'],
    { guard },
  );
  await n.close();
  return { token, registry };
}

describe('token leak canary: executor', () => {
  it('keeps a token that a server echoes out of step records, model requests and spans', async () => {
    const requests: ChatRequest[] = [];
    const { ctx, control, tools } = setup(def, {
      providers: [recording(requests)],
      store: echoing(),
    });
    try {
      // Without registration the canary would pass: it matches no generic secret pattern.
      expect(tools.guard.text(CANARY).text).toBe(CANARY);
      const { token } = await storeAndFetchToken(tools.guard);
      expect(token).toBe(CANARY);
      expect(tools.guard.text(CANARY).text).not.toContain(CANARY);

      ctx.telemetry = executorTelemetry({
        runId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
        tenantRootId: '33333333-3333-4333-8333-333333333333',
      });
      let result!: Awaited<ReturnType<typeof executePipeline>>;
      await withSpan({ name: 'invoke_workflow t', kind: 'invoke_workflow' }, {}, async () => {
        result = await executePipeline(prepared(def), ctx);
      });
      expect(result.status).toBe('succeeded');

      const modelSaw = JSON.stringify(requests.map((r) => r.messages as ChatMessage[]));
      expect(modelSaw).toContain('debug:'); // the tool result did reach the model, redacted
      expect(modelSaw).not.toContain(CANARY);
      expect(JSON.stringify(control.steps)).not.toContain(CANARY);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      const spans = t.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      expect(JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]))).not.toContain(
        CANARY,
      );
      expect(attributesComply(spans)).toEqual([]);
    } finally {
      await tools.close();
    }
  });
});
