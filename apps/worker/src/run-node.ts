import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CostModel,
  contextGuardFromEnv,
  OaxError,
  parseTraceparent,
  StaticSecretResolver,
  type AgentDefinition,
  type HarnessKind,
  type OaxEvent,
  type StepCredentials,
} from '@openagentix/core';
import { unpackSeed, type UnpackLimits } from './seed-unpack.js';
import {
  ToolGateway,
  checkStdioConfig,
  stdioError,
  type InMemoryTransportFactory,
  type McpServerConfig,
} from '@openagentix/mcp';
import { ProviderRegistry, type ModelProvider } from '@openagentix/providers';
import {
  HttpControlPlane,
  ModelProxyProvider,
  createHarness,
  executePipeline,
  executeWithHarness,
  type ExternalHarness,
  type FetchFn,
  MAX_WORKSPACE_SEED_BYTES,
  PatchAttachmentSchema,
  type PatchAttachment,
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
  /** Injectable for tests: removes the token file once it was read (default: unlink a regular file). */
  removeTokenFile?: (path: string) => Promise<void>;
  /** In-process MCP servers (demo/tests); without them `in-memory` connections cannot be reached. */
  inMemoryMcp?: InMemoryTransportFactory;
  /** Injectable for tests: resolves the real path of a stdio command (`null` = missing). */
  resolveStdioPath?: (path: string) => string | null;
  /** Injectable for tests: whether this process could change a stdio binary or its directory. */
  stdioWritable?: (path: string) => boolean;
  /** Providers usable without the control node (unit tests only); default none: all calls are proxied. */
  localProviders?: ModelProvider[];
  /** Replaces the harness adapter (tests use fakes; the node binary never sets it). */
  harnessFactory?: (kind: HarnessKind) => ExternalHarness;
  /** Parent of the temporary work directory of a harness run (default: the OS temp dir). */
  harnessWorkRoot?: string;
  /** How long to wait for the token file the runner uploads after the container started. */
  tokenWaitMs?: number;
  /** Workspace of a step with a `pull-request` output (DOG-4); defaults come from the environment. */
  workspace?: {
    root?: string;
    stateDir?: string;
    /** How long to wait for the workspace server's result file after the harness ended. */
    resultWaitMs?: number;
    limits?: Partial<UnpackLimits>;
    /** Command and arguments of `run_tests` (default: this node binary with `--test`). */
    tests?: { command: string; args: string[]; filePattern: string };
  };
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
 * Who defined each HTTP MCP server of the step. Without the `http` field every server counts as
 * tenant defined (fail closed).
 */
export function httpOriginFor(
  handover: Pick<StepHandover, 'http'>,
): (server: string) => 'platform' | 'tenant' {
  const tenant = handover.http ? new Set(handover.http.tenantServers) : undefined;
  return (server) => (tenant && !tenant.has(server) ? 'platform' : 'tenant');
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

/**
 * Second wall for tenant-defined stdio servers (ADR 0016 S0): the control node checked the
 * command rules against the stored connection; only the node can resolve symlinks of its own
 * image. Applies to the servers the handover names, on the configuration as stored (before the
 * broker's variables are merged in), with the real path required to exist.
 */
export function stdioGuardFor(
  handover: Pick<StepHandover, 'mcp' | 'stdio'>,
  resolve?: (p: string) => string | null,
  writable?: (p: string) => boolean,
): (cfg: Extract<McpServerConfig, { transport: 'stdio' }>) => void {
  const tenant = new Set(handover.stdio?.tenantServers ?? []);
  const stored = new Map(handover.mcp.map((c) => [c.name, c]));
  return (cfg) => {
    if (!tenant.has(cfg.name)) return;
    const orig = stored.get(cfg.name);
    // The configuration that is about to start must be the one that was checked.
    const same =
      orig?.transport === 'stdio' &&
      orig.command === cfg.command &&
      JSON.stringify(orig.args) === JSON.stringify(cfg.args);
    if (!orig || orig.transport !== 'stdio' || !same)
      throw new OaxError(
        'mcp_command_forbidden',
        `MCP server "${cfg.name}" changed after it was checked`,
      );
    const issues = checkStdioConfig(orig, {
      allowlist: handover.stdio?.allowlist ?? [],
      realpath: 'require',
      ...(resolve ? { resolve } : {}),
      ...(writable ? { writable } : {}),
    });
    if (issues.length > 0) throw stdioError(cfg.name, issues);
  };
}

/**
 * Harness adapters of a run node. Binaries are part of the node image (pinned and checksummed at
 * build time) and located by environment variables; nothing is ever downloaded at run time.
 */
function harnessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): (kind: HarnessKind) => ExternalHarness {
  return (kind) =>
    createHarness(kind, {
      ...(env.OAX_CLAUDE_BIN ? { command: env.OAX_CLAUDE_BIN } : {}),
      opencode: {
        ...(env.OAX_OPENCODE_BIN ? { command: env.OAX_OPENCODE_BIN } : {}),
        ...(env.OAX_OPENCODE_SHA256 ? { expectedSha256: env.OAX_OPENCODE_SHA256 } : {}),
      },
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

/**
 * The workspace of a step with a `pull-request` output (DOG-4, ADR 0008 Amendment 5): the seed is
 * fetched once with the step token, verified against the announced SHA-256 and unpacked with the
 * node's own checks; then the configuration of the `workspace` MCP server (root, test command) is
 * written by the node, never by the model. The server (a stdio connection of the step) writes its
 * final result next to it when the harness is done.
 */
interface NodeWorkspace {
  root: string;
  stateDir: string;
  resultFile: string;
}

async function prepareWorkspace(
  control: HttpControlPlane,
  runId: string,
  agentId: string,
  opts: RunNodeOptions,
  env: NodeJS.ProcessEnv,
): Promise<NodeWorkspace> {
  const root = opts.workspace?.root ?? env.OAX_WORKSPACE_ROOT ?? '/tmp/workspace';
  const stateDir = opts.workspace?.stateDir ?? env.OAX_WORKSPACE_STATE_DIR ?? '/tmp/oax-workspace';
  const seed = await control.fetchWorkspaceSeed(runId, agentId, MAX_WORKSPACE_SEED_BYTES);
  await unpackSeed(seed.archive, seed.sha256, root, {
    maxArchiveBytes: MAX_WORKSPACE_SEED_BYTES,
    maxFiles: 5_000,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: MAX_WORKSPACE_SEED_BYTES,
    maxPathChars: 300,
    maxDepth: 24,
    ...opts.workspace?.limits,
  });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tests = opts.workspace?.tests ?? {
    command: process.execPath,
    args: ['--test'],
    filePattern: '^test/[a-z0-9-]+\\.test\\.js$',
  };
  await writeFile(
    join(stateDir, 'config.json'),
    JSON.stringify({ root, tests: { ...tests, timeoutMs: 60_000, memoryMb: 1024, maxRuns: 8 } }),
    { mode: 0o600, flag: 'wx' },
  );
  return { root, stateDir, resultFile: join(stateDir, 'result.json') };
}

type PatchOutcome =
  { ok: true; patch: PatchAttachment } | { ok: false; code: string; message: string };

const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Reads the workspace server's result file (waits for it: the server writes it while it shuts down). */
async function readWorkspaceResult(file: string, waitMs: number): Promise<PatchOutcome> {
  const deadline = Date.now() + waitMs;
  let text: string | undefined;
  for (;;) {
    try {
      // O_NOFOLLOW: a link planted at the result path is never followed. O_NONBLOCK: a FIFO planted
      // there (test code runs with the node's UID) cannot block the open; only a regular file is
      // read, and never more than the cap, even when it keeps growing while it is read.
      const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_RESULT_BYTES) throw new Error('not a usable result');
        const buf = Buffer.alloc(MAX_RESULT_BYTES + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > MAX_RESULT_BYTES) throw new Error('too large');
        }
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline)
        return {
          ok: false,
          code: 'workspace_result_missing',
          message: 'the workspace server left no usable result',
        };
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const invalid = (): PatchOutcome => ({
    ok: false,
    code: 'workspace_result_invalid',
    message: 'the workspace result has an unexpected shape',
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid();
  }
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const top = rec(raw);
  const p = rec(top?.patch);
  if (!top || !p) return invalid();
  if (p.ok === false) {
    const code = typeof p.code === 'string' && /^[a-z_]{1,60}$/.test(p.code) ? p.code : 'invalid';
    return {
      ok: false,
      code: `workspace_${code}`,
      message: (typeof p.message === 'string' ? p.message : 'the patch was refused').slice(0, 500),
    };
  }
  if (p.ok !== true || typeof p.patch !== 'string') return invalid();
  if (p.patch.length === 0)
    return { ok: false, code: 'no_changes', message: 'the agent changed nothing' };
  const run = rec(top.lastTestRun);
  const candidate = {
    patch: p.patch,
    patchSha256: p.patchSha256,
    changedFiles: p.changedFiles,
    lastTestRun: run
      ? {
          passed: run.passed,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          durationMs:
            typeof run.durationMs === 'number' ? Math.round(run.durationMs) : run.durationMs,
          file: run.file,
        }
      : null,
    fullSuitePassed: top.fullSuitePassed,
    treeMatchesLastRun: top.treeMatchesLastRun,
    testedFinalTree: top.testedFinalTree,
  };
  // changedFiles of the workspace carry exactly these four fields; anything else is refused.
  const parsed = PatchAttachmentSchema.safeParse(candidate);
  return parsed.success ? { ok: true, patch: parsed.data } : invalid();
}

async function removeRegularFile(path: string): Promise<void> {
  if ((await lstat(path)).isFile()) await unlink(path);
}

/** Runs one step; returns the process exit code (0 only when the result was accepted). */
export async function runNode(opts: RunNodeOptions = {}): Promise<number> {
  const write = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // `TRACEPARENT` is for log correlation only (ADR 0015 6.1): the node has no exporter and sends no
  // trace header. Only a well-formed value is used, and only to tag the node's own log lines.
  const context = parseTraceparent((opts.env ?? process.env).TRACEPARENT);
  const log = context
    ? (line: string) => write(`${line} trace_id=${context.traceId} span_id=${context.spanId}`)
    : write;
  const read = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let env: NodeEnv;
  let control: HttpControlPlane;
  let proxyUrl: string | undefined;
  let runToken: string | undefined;
  try {
    env = parseNodeEnv(opts.env ?? process.env);
    const bundle = await readBundle(env.tokenFile, read, sleep, opts.tokenWaitMs ?? 30_000);
    proxyUrl = bundle.proxyUrl;
    runToken = bundle.token;
    // The token lives in memory from here on (it is never re-read: there is no refresh), so a
    // file on disk only helps a harness child that learns its path. Best effort: a container
    // reads `/dev/stdin`, a mounted Secret is read-only; neither can or needs to be removed.
    await (opts.removeTokenFile ?? removeRegularFile)(env.tokenFile).catch(() => undefined);
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
  let workspace: NodeWorkspace | undefined;
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
    // A step with a `pull-request` output works on the seed of its target (DOG-4).
    if (handover.agent.outputs.some((o) => o.format === 'pull-request'))
      workspace = await prepareWorkspace(
        control,
        env.runId,
        agentId,
        opts,
        opts.env ?? process.env,
      );
    const proxyEnv: Record<string, string> = proxyUrl
      ? { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl }
      : {};
    // Everything this node holds in secret form is known to the guard: brokered credentials, the
    // step's run token. The model token never reaches the node process itself (harness only).
    const guard = contextGuardFromEnv(opts.env ?? process.env, [
      ...(runToken ? [runToken] : []),
      ...creds.credentials.map((c) => c.value),
      ...creds.connections.flatMap((c) => [
        ...Object.values(c.env ?? {}),
        ...Object.values(c.headers ?? {}),
      ]),
    ]);
    const stdioGuard = stdioGuardFor(handover, opts.resolveStdioPath, opts.stdioWritable);
    // Fail before any server starts, with the offending connection named.
    for (const cfg of handover.mcp) if (cfg.transport === 'stdio') stdioGuard(cfg);
    tools = new ToolGateway(
      mergeCredentials(handover.mcp, creds, proxyEnv),
      {
        secrets: new StaticSecretResolver({}),
        env: proxyEnv,
        stdioGuard,
        // Tenant-defined HTTP servers get the tenant destination rules; the node cannot resolve
        // external names (the egress proxy does), so the DNS check is the proxy's (ADR 0016 4.5).
        originFor: httpOriginFor(handover),
        proxyChecksDestination: Boolean(proxyUrl),
        ...(opts.inMemoryMcp ? { inMemory: opts.inMemoryMcp } : {}),
      },
      guard,
    );
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
    const ctx = {
      providers,
      tools,
      control,
      costModel: new CostModel([]),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const kind = handover.agent.runtime?.harness;
    const result = kind
      ? await executeWithHarness(
          run,
          ctx,
          (opts.harnessFactory ?? harnessFromEnv(opts.env))(kind),
          {
            ...(opts.harnessWorkRoot ? { workRoot: opts.harnessWorkRoot } : {}),
            // The harness child gets the model token of its step and nothing else (ADR 0009 section 10).
            modelProxy: async (agent) => {
              const t = await control.issueHarnessModelToken(env.runId, agent.id, kind);
              if (t.protocol === 'native')
                throw new OaxError(
                  'model_surface_mismatch',
                  'the control node answered with no harness surface',
                );
              return { protocol: t.protocol, baseUrl: t.baseUrl, token: t.token, model: t.model };
            },
          },
        )
      : await executePipeline(run, ctx);
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
    let patch: PatchAttachment | undefined;
    if (workspace) {
      // The workspace server writes its result while it shuts down: close the tools first.
      await tools.close().catch(() => undefined);
      const outcome = await readWorkspaceResult(
        workspace.resultFile,
        opts.workspace?.resultWaitMs ?? 20_000,
      );
      if (!outcome.ok)
        return await report({
          agentId,
          format: 'none',
          content: '',
          failure: { status: 'failed', code: outcome.code, message: outcome.message },
          usage: result.usage,
        });
      patch = outcome.patch;
    }
    return await report({
      agentId,
      format: out.format,
      content: out.content,
      ...(Object.hasOwn(out, 'json') ? { json: out.json } : {}),
      ...(patch ? { patch } : {}),
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
    if (workspace) {
      await rm(workspace.root, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace.stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
