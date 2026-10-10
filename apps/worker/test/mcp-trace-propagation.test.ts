import { withSpan } from '@openagentix/api';
import { StaticSecretResolver } from '@openagentix/core';
import {
  McpServerConfigSchema,
  ToolGateway,
  createMockMcpServer,
  inMemoryServers,
  type McpPropagationPolicy,
} from '@openagentix/mcp';
import { executePipeline } from '@openagentix/runners';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTelemetryRuntime } from '../../api/src/telemetry.js';
import { attributesComply, startTracing } from '../../api/test/trace-harness.js';
import { agentFile, prepared, setup } from '../../../packages/runners/test/helpers.js';
import { executorTelemetry } from '../src/executor-spans.js';

/**
 * ADR 0015 S8 end to end inside the worker: the executor offers the run's own `execute_tool` span
 * position, the gateway sends it only with both opt-ins, and the span is labelled. The MCP server
 * records the `_meta` of every `tools/call` it receives.
 */
let t: ReturnType<typeof startTracing>;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
  await t.stop();
  resetTelemetryRuntime();
});

const def = agentFile(`    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - text: done`);

async function run(opts: {
  telemetry: unknown;
  platform: McpPropagationPolicy | undefined;
  tracing?: boolean;
}) {
  const received: unknown[] = [];
  const server = () =>
    createMockMcpServer('cve-db', [
      {
        name: 'lookup_cve',
        handler: (_args, meta) => {
          received.push(meta ?? null);
          return 'ok';
        },
      },
    ]);
  const s = setup(def);
  s.ctx.tools = new ToolGateway(
    [
      McpServerConfigSchema.parse({
        name: 'cve-db',
        transport: 'in-memory',
        ...(opts.telemetry === undefined ? {} : { telemetry: opts.telemetry }),
      }),
    ],
    {
      secrets: new StaticSecretResolver({}),
      inMemory: inMemoryServers({ 'cve-db': server }),
      ...(opts.platform ? { tracePropagation: opts.platform } : {}),
    },
  );
  cleanups.push(() => s.ctx.tools.close());
  if (opts.tracing !== false) {
    const telemetry = executorTelemetry({
      runId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    if (telemetry) s.ctx.telemetry = telemetry;
  }
  let status = '';
  await withSpan({ name: 'invoke_workflow t', kind: 'invoke_workflow' }, {}, async () => {
    status = (await executePipeline(prepared(def, {}), s.ctx)).status;
  });
  expect(status).toBe('succeeded');
  const spans = t.exporter.getFinishedSpans();
  const tool = spans.find((x) => x.name.startsWith('execute_tool'))!;
  return { received, tool, spans };
}

describe('MCP trace propagation from the executor', () => {
  it('both opt-ins: the server gets the traceparent of the execute_tool span, and the span says so', async () => {
    const { received, tool, spans } = await run({
      telemetry: { propagate: true },
      platform: 'allow',
    });
    const c = tool.spanContext();
    expect(received).toEqual([{ traceparent: `00-${c.traceId}-${c.spanId}-01` }]);
    expect(tool.attributes).toMatchObject({
      'mcp.method.name': 'tools/call',
      'oax.mcp.propagated': true,
    });
    expect(attributesComply(spans)).toEqual([]);
  });

  it.each([
    ['default (no setting, no switch)', undefined, undefined],
    ['connection on, platform deny', { propagate: true }, 'deny'],
    ['connection on, platform unset', { propagate: true }, undefined],
    ['connection off, platform allow', { propagate: false }, 'allow'],
  ] as const)('%s: nothing is sent and the span is unchanged', async (_l, telemetry, platform) => {
    const { received, tool } = await run({ telemetry, platform });
    expect(received).toEqual([null]);
    expect(
      Object.keys(tool.attributes).filter(
        (k) => k.startsWith('mcp.') || k === 'oax.mcp.propagated',
      ),
    ).toEqual([]);
  });

  it('without a tracing SDK nothing is sent even with both opt-ins', async () => {
    await t.stop();
    t = startTracing();
    const { received } = await run({
      telemetry: { propagate: true },
      platform: 'allow',
      tracing: false,
    });
    expect(received).toEqual([null]);
  });
});
