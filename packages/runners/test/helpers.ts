import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CostModel,
  StaticSecretResolver,
  loadAgentDefinition,
  type AgentDefinition,
} from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  type Ticket,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider, type ModelProvider } from '@openagentix/providers';
import {
  LocalControlPlane,
  type LocalControlPlaneOptions,
  type PreparedRun,
  type RunnerContext,
} from '../src/index.js';

export const example = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url)), 'utf8');

export const secrets = new StaticSecretResolver({});

export function setup(
  def: AgentDefinition,
  opts: {
    providers?: ModelProvider[];
    control?: Partial<LocalControlPlaneOptions>;
    store?: Map<string, Ticket>;
  } = {},
) {
  const store = opts.store ?? new Map<string, Ticket>();
  const tools = new ToolGateway(
    [
      McpServerConfigSchema.parse({ name: 'cve-db', transport: 'in-memory' }),
      McpServerConfigSchema.parse({ name: 'tickets', transport: 'in-memory' }),
    ],
    { secrets, inMemory: inMemoryServers(demoServerFactories(store)) },
  );
  const control = new LocalControlPlane({ definition: def, ...opts.control });
  const ctx: RunnerContext = {
    providers: ProviderRegistry.of(
      opts.providers ?? [new SimulatedProvider({ name: 'simulated' })],
    ),
    tools,
    control,
    costModel: new CostModel([
      {
        provider: 'simulated',
        model: 'priced',
        inputPerMTok: 1_000_000,
        outputPerMTok: 0,
        perToolCallUsd: 0.01,
      },
    ]),
    sleep: async () => undefined,
  };
  return { ctx, control, tools, store };
}

export function prepared(def: AgentDefinition, data: unknown = {}): PreparedRun {
  return {
    runId: 'run-1',
    definition: def,
    event: createEvent({ source: '/test', type: 'test', data }),
    policies: [],
  };
}

export function agentFile(agentYaml: string, extra = ''): AgentDefinition {
  return loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: t
version: 1.0.0
owner: team
${extra}
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Do it.
${agentYaml}
---
`);
}
