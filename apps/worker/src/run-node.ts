import { readFile } from 'node:fs/promises';
import {
  CostModel,
  OaxError,
  StaticSecretResolver,
  type AgentDefinition,
  type OaxEvent,
  type StepCredentials,
} from '@openagentix/core';
import { ToolGateway, type InMemoryTransportFactory, type McpServerConfig } from '@openagentix/mcp';
import { ProviderRegistry, type ModelProvider } from '@openagentix/providers';
import {
  HttpControlPlane,
  ModelProxyProvider,
  executePipeline,
  type FetchFn,
  type PreparedRun,
  type StepHandover,
  type StepHandoverResult,
} from '@openagentix/runners';

/**
 * The run node (ADR 0008, section 3): an untrusted, short-lived process that executes exactly one
 * step against the control node. It talks to the control node only through {@link HttpControlPlane}
 * with the step-scoped run token it finds in a file, and it never connects to PostgreSQL or Valkey
 * (this module must not import `@openagentix/api`; a test enforces that). Credentials are fetched
 * once from the broker and live in memory only; they reach the step's tool processes as their
 * environment and nothing else.
 */

export interface RunNodeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchFn;
  /** Injectable for tests. */
  readFile?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** In-process MCP servers (demo/tests); without them `in-memory` connections cannot be reached. */
  inMemoryMcp?: InMemoryTransportFactory;
  /** Providers usable without the control node (unit tests only); default none: all calls are proxied. */
  localProviders?: ModelProvider[];
  /** How long to wait for the token file the runner uploads after the container started. */
  tokenWaitMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface NodeEnv {
  controlUrl: string;
  runId: string;
  nodeId: string | undefined;
  stepIds: string[];
  /** File with the run token on line 1 and, optionally, the egress proxy account on line 2. */
  tokenFile: string;
}

const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

/** Parses the node's environment; anything unexpected is an error (fail closed). */
export function parseNodeEnv(env: NodeJS.ProcessEnv): NodeEnv {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new OaxError('config_invalid', `${name} is required`);
    return v;
  };
  const controlUrl = need('OAX_CONTROL_URL');
  let u: URL;
  try {
    u = new URL(controlUrl);
  } catch {
    throw new OaxError('config_invalid', 'OAX_CONTROL_URL is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new OaxError('config_invalid', 'OAX_CONTROL_URL must be an http(s) URL');
  const stepIds = need('OAX_STEP_IDS').split(',');
  // v0.2: one node per step. A longer list is reserved for step groups (ADR 0008, section 3.1).
  if (stepIds.length !== 1 || !SLUG.test(stepIds[0]!))
    throw new OaxError('config_invalid', 'OAX_STEP_IDS must name exactly one valid step id');
  const runId = need('OAX_RUN_ID');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(runId))
    throw new OaxError('config_invalid', 'OAX_RUN_ID is not a valid run id');
  return {
    controlUrl,
    runId,
    nodeId: env.OAX_NODE_ID,
    stepIds,
    tokenFile: need('OAX_RUN_TOKEN_FILE'),
  };
}

export interface TokenBundle {
  token: string;
  /** `http://<node>:<password>@proxy:port/`: the node's account at the egress proxy. */
  proxyUrl?: string;
}

/**
 * Reads the run token (line 1) and the optional egress proxy URL (line 2). In a container the file
 * is `/dev/stdin`: the runner writes both once and closes stdin, so a read returns exactly when the
 * secrets arrived. Files that do not exist yet (mounted Secrets) are retried until the deadline.
 */
async function readBundle(
  file: string,
  read: (p: string) => Promise<string>,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
): Promise<TokenBundle> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const text = await Promise.race([
        read(file),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new OaxError('run_token_invalid', 'no run token arrived in time')),
            Math.max(0, deadline - Date.now()),
          ).unref(),
        ),
      ]);
      const [token = '', proxy = ''] = text.split('\n').map((l) => l.trim());
      if (token.startsWith('oaxrt.')) {
        if (!proxy) return { token };
        const u = new URL(proxy);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          throw new OaxError('config_invalid', 'the egress proxy URL must be http(s)');
        return { token, proxyUrl: proxy };
      }
    } catch (e) {
      if (e instanceof OaxError) throw e;
      // not there yet
    }
    if (Date.now() >= deadline)
      throw new OaxError('run_token_invalid', 'no run token arrived in time');
    await sleep(100);
  }
}

/**
 * Merges the broker's values into the MCP connections of the step: stdio servers get their
 * `env` values plus the step's declared credentials, HTTP servers their header values. Secret
 * references were stripped by the control node already, so no resolver is needed.
 */
export function mergeCredentials(
  configs: readonly McpServerConfig[],
  creds: StepCredentials,
  proxyEnv: Record<string, string>,
): McpServerConfig[] {
  const declared = Object.fromEntries(creds.credentials.map((c) => [c.env, c.value]));
  return configs.map((cfg) => {
    const c = creds.connections.find((x) => x.server === cfg.name);
    if (cfg.transport === 'stdio')
      return { ...cfg, env: { ...cfg.env, ...proxyEnv, ...declared, ...c?.env }, envSecrets: {} };
    if (cfg.transport === 'streamable-http')
      return { ...cfg, headers: { ...cfg.headers, ...c?.headers }, headerSecrets: {} };
    return cfg;
  });
}

function stepDefinition(h: StepHandover): AgentDefinition {
  return {
    apiVersion: 'openagentix.io/v1alpha1',
    kind: 'AgentPipeline',
    name: h.run.name,
    version: h.run.version,
    owner: 'run-node',
    classification: h.run.classification,
    labels: {},
    triggers: [{ type: 'manual' }],
    budget: h.run.budget,
    approvals: { approverRoles: ['operator', 'admin'], timeoutSeconds: 3600 },
    mode: 'standard',
    guidelines: [],
    runtime: { runner: 'in-process', egress: [] },
    agents: [{ ...h.agent, instructions: h.agent.instructions ?? '', tools: h.agent.tools }],
    pipeline: [h.agent.id],
    overview: '',
    sections: {},
    digest: '',
  } as AgentDefinition;
}

/** Runs one step; returns the process exit code (0 only when the result was accepted). */
export async function runNode(opts: RunNodeOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const read = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let env: NodeEnv;
  let control: HttpControlPlane;
  let proxyUrl: string | undefined;
  try {
    env = parseNodeEnv(opts.env ?? process.env);
    const bundle = await readBundle(env.tokenFile, read, sleep, opts.tokenWaitMs ?? 30_000);
    proxyUrl = bundle.proxyUrl;
    control = new HttpControlPlane({
      baseUrl: env.controlUrl,
      runToken: bundle.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (e) {
    log(`run node cannot start: ${(e as Error).message}`);
    return 2;
  }
  const agentId = env.stepIds[0]!;
  let tools: ToolGateway | undefined;
  const report = async (result: StepHandoverResult): Promise<number> => {
    try {
      await control.postHandoverResult(env.runId, result);
      return 0;
    } catch (e) {
      log(`could not post the step result: ${(e as Error).message}`);
      return 1;
    }
  };
  try {
    const handover = await control.fetchHandover(env.runId, agentId);
    if (handover.agentId !== agentId)
      throw new OaxError('run_node_invalid', 'the handover is for another step');
    const creds = await control.fetchCredentials(env.runId, agentId);
    const proxyEnv: Record<string, string> = proxyUrl
      ? { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl }
      : {};
    tools = new ToolGateway(mergeCredentials(handover.mcp, creds, proxyEnv), {
      secrets: new StaticSecretResolver({}),
      env: proxyEnv,
      ...(opts.inMemoryMcp ? { inMemory: opts.inMemoryMcp } : {}),
    });
    // Every model call of a node goes through the control node's model proxy (ADR 0009), the
    // simulated provider included, so tests and demos exercise the real path. `localProviders` is
    // for unit tests only; the node binary never sets it.
    const local = opts.localProviders ?? [];
    const providers = ProviderRegistry.of(
      local.some((p) => p.name === handover.agent.provider)
        ? local
        : [
            ...local,
            new ModelProxyProvider({
              name: handover.agent.provider,
              runId: env.runId,
              agentId,
              client: control,
            }),
          ],
    );
    const event: OaxEvent = {
      specversion: '1.0',
      id: env.runId,
      source: '/openagentix/run-node',
      type: 'io.openagentix.step.input',
      data: handover.input ?? null,
    };
    const run: PreparedRun = {
      runId: env.runId,
      definition: stepDefinition(handover),
      event,
      policies: [],
    };
    const result = await executePipeline(run, {
      providers,
      tools,
      control,
      costModel: new CostModel([]),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const out = result.outputs[0];
    if (result.status !== 'succeeded' || !out) {
      return await report({
        agentId,
        format: 'none',
        content: '',
        failure: {
          status: result.status === 'succeeded' ? 'failed' : (result.status as 'failed'),
          code: result.error?.code ?? 'run_node_no_output',
          message: result.error?.message ?? 'the step produced no output',
        },
        usage: result.usage,
      });
    }
    return await report({
      agentId,
      format: out.format,
      content: out.content,
      ...(Object.hasOwn(out, 'json') ? { json: out.json } : {}),
      usage: result.usage,
    });
  } catch (e) {
    log(`run node failed: ${(e as Error).message}`);
    // Best effort: tell the orchestrator why. If this fails too, the missing result fails the step.
    await report({
      agentId,
      format: 'none',
      content: '',
      failure: {
        status: 'failed',
        code: e instanceof OaxError ? e.code : 'run_node_error',
        message: (e as Error).message.slice(0, 500),
      },
    });
    return 1;
  } finally {
    await tools?.close().catch(() => undefined);
  }
}
