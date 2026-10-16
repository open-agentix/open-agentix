import type { AgentSpec } from '../agents/parser.js';
import type { PublishedDefinition } from '../agents/profiles.js';
import { exportBudget } from './export-budget.js';
import { rejectUnknownKeys, type ExportContext } from './export-context.js';
import { exportTools } from './export-tools.js';
import { EXTENSION_PREFIX, type JsonObject, type JsonValue } from './types.js';

const KNOWN_AGENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'description',
  'provider',
  'model',
  'temperature',
  'maxTokensPerCall',
  'instructions',
  'tools',
  'profileGrants',
  'toolbox',
  'outputs',
  'budget',
  'simulation',
  'input',
  'output',
  'when',
  'access',
  'credentials',
  'runtime',
]);

/** The `outputs` an agent without an `outputs` field gets from the schema. */
const DEFAULT_OUTPUTS = '[{"format":"markdown"}]';

export interface SecretUse {
  /** Name in the AWP manifest. */
  name: string;
  /** Reference as written in `agents.md`. */
  ref: string;
  agentId: string;
  env?: string;
}

export interface AgentExport {
  agent: JsonObject;
  step: JsonObject;
  secrets: SecretUse[];
  approvalRequired: string[];
}

const AWP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

/** AWP secret names are narrower than OpenAgentix references; the original goes to `key`. */
export function awpSecretName(ref: string): string {
  if (AWP_NAME.test(ref)) return ref;
  const cleaned = ref.replace(/[^a-zA-Z0-9_-]/g, '-');
  return (/^[a-zA-Z]/.test(cleaned) ? cleaned : `s-${cleaned}`).slice(0, 63);
}

function extension(name: string): string {
  return `${EXTENSION_PREFIX}${name}`;
}

/** Operational extensions: ignoring one never allows more than the source allows. */
function operationalExtensions(agent: AgentSpec, target: JsonObject): void {
  if (agent.description !== undefined) target[extension('description')] = agent.description;
  const model: JsonObject = {};
  if (agent.temperature !== undefined) model.temperature = agent.temperature;
  if (agent.maxTokensPerCall !== undefined) model.maxTokensPerCall = agent.maxTokensPerCall;
  if (Object.keys(model).length > 0) target[extension('model')] = model;
  const outputs = JSON.stringify(agent.outputs ?? []);
  if (agent.outputs && outputs !== DEFAULT_OUTPUTS)
    target[extension('outputs')] = agent.outputs as JsonValue;
  if (agent.simulation) target[extension('simulation')] = agent.simulation as JsonValue;
}

/** `x-openagentix-runtime` carries runner, toolbox (critical) and harness (operational). */
function runtimeExtension(
  ctx: ExportContext,
  agent: AgentSpec,
  index: number,
  target: JsonObject,
): void {
  const runtime: JsonObject = {};
  if (agent.runtime?.runner !== undefined) {
    runtime.runner = agent.runtime.runner;
    ctx.noteCritical('runtime.runner', `agents.${index}.runtime.runner`);
  }
  if (agent.toolbox !== undefined) {
    runtime.toolbox = agent.toolbox;
    ctx.noteCritical('runtime.toolbox', `agents.${index}.toolbox`);
  }
  if (agent.runtime?.harness !== undefined) runtime.harness = agent.runtime.harness;
  if (Object.keys(runtime).length > 0) target[extension('runtime')] = runtime;
}

/** Step-level restrictions (conditions, handovers, access class) as critical extensions. */
function stepExtensions(
  ctx: ExportContext,
  agent: AgentSpec,
  index: number,
  step: JsonObject,
): void {
  const at = (field: string) => `agents.${index}.${field}`;
  if (agent.when !== undefined) ctx.critical(step, 'when', at('when'), agent.when);
  if (agent.input !== undefined) ctx.critical(step, 'input', at('input'), agent.input as JsonValue);
  if (agent.output !== undefined)
    ctx.critical(step, 'output', at('output'), agent.output as JsonValue);
  if (agent.access !== undefined) ctx.critical(step, 'access', at('access'), agent.access);
}

function secretUses(agent: AgentSpec): SecretUse[] {
  return (agent.credentials ?? []).map((c) => ({
    name: awpSecretName(c.secret),
    ref: c.secret,
    agentId: agent.id,
    ...(c.env !== undefined ? { env: c.env } : {}),
  }));
}

function agentPermissions(
  agent: AgentSpec,
  def: PublishedDefinition,
  permissionTools: JsonObject,
  secrets: SecretUse[],
): JsonObject {
  const egress = agent.runtime?.egress ?? def.runtime?.egress ?? [];
  const network: JsonObject = { egress: 'deny' };
  if (egress.length > 0) network.allowHosts = [...egress];
  const permissions: JsonObject = { default: 'deny', network };
  if (Object.keys(permissionTools).length > 0) permissions.tools = permissionTools;
  if (secrets.length > 0) permissions.secrets = [...new Set(secrets.map((s) => s.name))];
  return permissions;
}

/** Exports one agent as an AWP inline agent plus the workflow step that runs it. */
export function exportAgent(
  ctx: ExportContext,
  def: PublishedDefinition,
  agent: AgentSpec,
  index: number,
): AgentExport {
  rejectUnknownKeys(ctx, agent, KNOWN_AGENT_KEYS, `agents.${index}`);
  const tools = exportTools(ctx, def, agent, index);
  const secrets = secretUses(agent);
  const out: JsonObject = {
    id: agent.id,
    model: { provider: agent.provider, name: agent.model },
    instructions: agent.instructions,
  };
  if (tools.sources.length > 0) out.tools = tools.sources;
  out.permissions = agentPermissions(agent, def, tools.permissionTools, secrets);
  const budget = exportBudget(agent.budget);
  if (budget) out.budget = budget;
  operationalExtensions(agent, out);
  const credentialEnv = Object.fromEntries(
    secrets.flatMap((s) => (s.env ? [[s.name, s.env]] : [])),
  );
  if (Object.keys(credentialEnv).length > 0) out[extension('credentialEnv')] = credentialEnv;
  runtimeExtension(ctx, agent, index, out);
  const step: JsonObject = { id: agent.id, type: 'agent', agent: agent.id };
  stepExtensions(ctx, agent, index, step);
  return { agent: out, step, secrets, approvalRequired: tools.approvalRequired };
}
