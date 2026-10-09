import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  DefaultSecretResolver,
  OaxError,
  effectiveBudget,
  getEgressPolicy,
  type AgentDefinition,
  type AgentSpec,
  type SecretResolver,
} from '@openagentix/core';
import type { ExposedTool } from '@openagentix/mcp';
import type { ProviderConfig } from '@openagentix/providers';
import { buildSystemPrompt } from '../executor.js';
import {
  HARNESS_DEFAULT_TIMEOUT_MS,
  assertProxyInvocation,
  gateSecrets,
  harnessLimits,
  type ExternalHarness,
  type GateEndpoint,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessToolEvent,
  type ModelProxyEndpoint,
} from '../harness.js';
import {
  prepareWorkdir,
  runHarnessProcess,
  type OutputParser,
  type ParsedOutput,
} from './process.js';

/**
 * OpenCode (https://opencode.ai) as an external harness. The documented command-line contract the
 * adapter relies on (see docs/harnesses.md and docs/verification/opencode-harness.md):
 *
 * - `opencode run --format json --model <provider>/<model> --agent <name>` runs one prompt
 *   non-interactively (prompt on stdin) and prints one JSON event per line (`step_start`, `text`,
 *   `tool_use`, `step_finish`, `error`).
 * - The configuration is read from the file named by `OPENCODE_CONFIG`; project and global
 *   configuration, auto-update, model catalog download, LSP download and plugins are switched off.
 */

export const OPENCODE_AGENT = 'oax';
const MAX_TOOL_OUTPUT = 2_000;
const API_KEY_ENV = 'OAX_OPENCODE_API_KEY';
const HEADER_ENV_PREFIX = 'OAX_OPENCODE_HEADER_';
const CONFIG_FILE = '.openagentix/opencode.json';

/** Built-in OpenCode tools that would bypass the gate; all of them are switched off. */
export const OPENCODE_BUILTIN_TOOLS = [
  'bash',
  'edit',
  'write',
  'read',
  'grep',
  'glob',
  'list',
  'patch',
  'webfetch',
  'websearch',
  'codesearch',
  'task',
  'todowrite',
  'todoread',
  'skill',
  'lsp',
  'external_directory',
  'doom_loop',
] as const;

export interface OpenCodeOptions {
  /** Binary, default `opencode`. Installed (pinned) at image build time, never downloaded. */
  command?: string;
  /** Expected SHA-256 (hex) of the binary; requires an absolute `command`. */
  expectedSha256?: string;
  /** Model connections (BYOK); the agent's `provider:` selects one by name. */
  providers?: readonly ProviderConfig[];
  /** Resolves the secret references of the connection (default: `OAX_SECRET_*` / secrets dir). */
  secrets?: SecretResolver;
  /** Platform default when the agent sets no step budget. */
  defaultMaxSteps?: number;
  /** Time limit of a proxied run when the agent sets none (default 30 minutes). */
  defaultTimeoutMs?: number;
}

interface ProviderPlan {
  /** Config entry of the provider (no secret values). */
  entry: Record<string, unknown>;
  /** URL the CLI will contact (egress check in air-gapped mode). */
  endpoint: string;
  apiKeySecret?: string | undefined;
  /** header name -> secret reference */
  headerSecrets: Record<string, string>;
}

/** Provider id of the proxy inside the generated config (never the name of a real connection). */
export const OPENCODE_PROXY_PROVIDER = 'oax-proxy';

interface RunMeta {
  plan: ProviderPlan;
  /** Model token of a proxied run; handed to the child as `OAX_OPENCODE_API_KEY`. */
  proxyToken?: string;
  serverName: string;
  providerLabel: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

function planProvider(cfg: ProviderConfig, model: string): ProviderPlan {
  const models = { [model]: {} };
  const openaiCompatible = (
    baseUrl: string,
    apiKeySecret?: string,
    headers?: object,
    hs?: object,
  ) => ({
    entry: {
      npm: '@ai-sdk/openai-compatible',
      name: cfg.name,
      options: {
        baseURL: trimSlash(baseUrl),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
      models,
    },
    endpoint: trimSlash(baseUrl),
    apiKeySecret,
    headerSecrets: (hs ?? {}) as Record<string, string>,
  });
  switch (cfg.kind) {
    case 'openai':
    case 'openai-compatible':
      return openaiCompatible(cfg.baseUrl, cfg.apiKeySecret, cfg.headers, cfg.headerSecrets);
    case 'openrouter':
      return openaiCompatible(cfg.baseUrl, cfg.apiKeySecret);
    case 'vllm':
      return openaiCompatible(cfg.baseUrl, cfg.apiKeySecret);
    case 'lmstudio':
      return openaiCompatible(cfg.baseUrl);
    case 'ollama':
      return openaiCompatible(`${trimSlash(cfg.baseUrl ?? 'http://localhost:11434')}/v1`);
    case 'anthropic': {
      const base = trimSlash(cfg.baseUrl ?? 'https://api.anthropic.com');
      return {
        entry: {
          npm: '@ai-sdk/anthropic',
          name: cfg.name,
          options: { baseURL: `${base}/v1` },
          models,
        },
        endpoint: base,
        apiKeySecret: cfg.apiKeySecret,
        headerSecrets: {},
      };
    }
    default:
      throw new OaxError(
        'harness_provider_unsupported',
        `the OpenCode harness cannot use the "${cfg.kind}" connection "${cfg.name}" (supported: openai, openai-compatible, openrouter, vllm, lmstudio, ollama, anthropic)`,
      );
  }
}

/**
 * The provider entry for a run through the proxy: one provider that speaks the surface's protocol,
 * `baseURL` = surface root + `/v1`, the model token as API key (via `{env:...}`) and no headers.
 */
function planProxy(proxy: ModelProxyEndpoint): ProviderPlan {
  const baseURL = `${trimSlash(proxy.baseUrl)}/v1`;
  return {
    entry: {
      npm: proxy.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
      name: OPENCODE_PROXY_PROVIDER,
      options: { baseURL },
      models: { [proxy.model]: {} },
    },
    endpoint: baseURL,
    apiKeySecret: undefined,
    headerSecrets: {},
  };
}

/** OpenCode in non-interactive mode with a deny-by-default config that only allows gate tools. */
export class OpenCodeHarness implements ExternalHarness {
  readonly name = 'opencode' as const;
  private readonly meta = new WeakMap<HarnessInvocation, RunMeta>();

  constructor(private readonly options: OpenCodeOptions = {}) {}

  buildInvocation(
    def: AgentDefinition,
    agent: AgentSpec,
    prompt: string,
    gate: GateEndpoint,
    tools?: readonly ExposedTool[],
    proxy?: ModelProxyEndpoint,
  ): HarnessInvocation {
    let plan: ProviderPlan;
    if (proxy) {
      // Through the proxy there is no connection on this side: the control node holds the key.
      if (proxy.model !== agent.model)
        throw new OaxError(
          'harness_proxy_invariant',
          'the model of the model token does not match the model of the step',
        );
      plan = planProxy(proxy);
    } else {
      const cfg = this.options.providers?.find((p) => p.name === agent.provider);
      if (!cfg)
        throw new OaxError(
          'harness_provider_unknown',
          `no model connection "${agent.provider}" is configured for the OpenCode harness`,
        );
      plan = planProvider(cfg, agent.model);
    }
    const providerId = proxy ? OPENCODE_PROXY_PROVIDER : agent.provider;
    const budget = effectiveBudget(def.budget, agent.budget);
    const maxTurns = budget.maxSteps ?? this.options.defaultMaxSteps ?? 25;
    const limits = harnessLimits(
      budget,
      maxTurns,
      proxy ? (this.options.defaultTimeoutMs ?? HARNESS_DEFAULT_TIMEOUT_MS) : undefined,
    );

    // OpenCode names MCP tools `<server>_<tool>`. Deny by default, allow exactly the served tools.
    const prefix = `${gate.serverName}_`;
    const allowed = tools
      ? tools.map((t) => `${prefix}${t.modelName}`)
      : agent.tools.map((t) => `${prefix}${t.server}__${t.tool}`);
    const denyAll: Record<string, 'deny' | 'allow'> = { '*': 'deny' };
    for (const b of OPENCODE_BUILTIN_TOOLS) denyAll[b] = 'deny';
    const permission = { ...denyAll, ...Object.fromEntries(allowed.map((n) => [n, 'allow'])) };
    const toolSwitches = {
      ...Object.fromEntries(OPENCODE_BUILTIN_TOOLS.map((b) => [b, false])),
      ...Object.fromEntries(allowed.map((n) => [n, true])),
    };
    const headers = Object.fromEntries(
      Object.keys(plan.headerSecrets).map((h, i) => [h, `{env:${HEADER_ENV_PREFIX}${i}}`]),
    );
    const entry = structuredClone(plan.entry) as { options: Record<string, unknown> };
    if (Object.keys(headers).length)
      entry.options.headers = { ...(entry.options.headers as object), ...headers };
    if (plan.apiKeySecret || proxy) entry.options.apiKey = `{env:${API_KEY_ENV}}`;

    const config = {
      $schema: 'https://opencode.ai/config.json',
      model: `${providerId}/${agent.model}`,
      default_agent: OPENCODE_AGENT,
      enabled_providers: [providerId],
      provider: { [providerId]: entry },
      // The loopback policy gate is the ONLY tool source.
      mcp: {
        [gate.serverName]: {
          type: 'remote',
          url: gate.url,
          headers: { Authorization: `Bearer ${gate.runToken}` },
          enabled: true,
        },
      },
      tools: toolSwitches,
      permission,
      agent: {
        [OPENCODE_AGENT]: {
          mode: 'primary',
          description: `openagentix agent ${agent.id}`,
          prompt: buildSystemPrompt(agent),
          steps: maxTurns,
          tools: toolSwitches,
          permission,
        },
      },
      plugin: [],
      instructions: [],
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      lsp: false,
      formatter: false,
    };
    const inv: HarnessInvocation = {
      command: this.options.command ?? 'opencode',
      args: [
        'run',
        '--format',
        'json',
        '--model',
        `${providerId}/${agent.model}`,
        '--agent',
        OPENCODE_AGENT,
      ],
      // Minimal environment; HOME/XDG/config paths are bound to the work dir in run().
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      },
      files: { [CONFIG_FILE]: JSON.stringify(config, null, 2) },
      stdin: prompt,
      limits,
      ...(proxy
        ? {
            modelProxy: { protocol: proxy.protocol, baseUrl: trimSlash(proxy.baseUrl) },
            redact: [proxy.token],
          }
        : {}),
    };
    this.meta.set(inv, {
      plan,
      ...(proxy ? { proxyToken: proxy.token } : {}),
      serverName: gate.serverName,
      providerLabel: providerId,
    });
    if (proxy) assertProxyInvocation(inv, proxy);
    return inv;
  }

  async run(inv: HarnessInvocation, opts: HarnessRunOptions): Promise<HarnessResult> {
    const meta = this.meta.get(inv);
    if (!meta)
      throw new OaxError('harness_invalid', 'the invocation was not built by this adapter');
    // The CLI talks to the model endpoint itself, invisible to the in-process network guard. Through
    // the proxy the endpoint is the control node, whose egress rules decide (ADR 0009 section 9).
    if (meta.proxyToken) assertProxyInvocation(inv);
    else getEgressPolicy().assert(meta.plan.endpoint, 'OpenCode harness (model endpoint)');
    await this.verifyBinary(inv.command);

    const cwd = await prepareWorkdir(opts.cwd, inv.files);
    const home = join(cwd, '.home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      ...inv.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
      OPENCODE_CONFIG: join(cwd, CONFIG_FILE),
    };
    const secrets: string[] = [...gateSecrets(inv), ...(inv.redact ?? [])];
    if (meta.proxyToken) env[API_KEY_ENV] = meta.proxyToken;
    // BYOK: only the references travel in the platform; the values live in this child's env.
    const resolver = this.options.secrets ?? new DefaultSecretResolver();
    if (meta.plan.apiKeySecret) {
      const key = (await resolver.resolve(meta.plan.apiKeySecret)).trim();
      if (!key) throw new OaxError('harness_auth', 'the model API key is empty');
      env[API_KEY_ENV] = key;
      secrets.push(key);
    }
    let i = 0;
    for (const ref of Object.values(meta.plan.headerSecrets)) {
      const value = (await resolver.resolve(ref)).trim();
      env[`${HEADER_ENV_PREFIX}${i++}`] = value;
      if (value) secrets.push(value);
    }
    return runHarnessProcess(
      inv,
      { cwd, env, secrets, signal: opts.signal },
      new OpenCodeOutputParser(meta.serverName),
    );
  }

  private async verifyBinary(command: string): Promise<void> {
    const want = this.options.expectedSha256?.toLowerCase();
    if (!want) return;
    if (!isAbsolute(command))
      throw new OaxError(
        'harness_binary_unverified',
        'a binary checksum requires an absolute path to the OpenCode binary',
      );
    let data: Buffer;
    try {
      data = await readFile(command);
    } catch (e) {
      throw new OaxError('harness_spawn_failed', `cannot read ${command}: ${(e as Error).message}`);
    }
    if (createHash('sha256').update(data).digest('hex') !== want)
      throw new OaxError(
        'harness_binary_mismatch',
        'the OpenCode binary does not match the pinned checksum',
      );
  }
}

// ---------- `opencode run --format json` parsing ----------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class OpenCodeOutputParser implements OutputParser {
  private text = '';
  private steps = 0;
  private finished = 0;
  private cost = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private sessionId: string | undefined;
  private error: string | undefined;
  private readonly tools = new Map<string, HarnessToolEvent>();

  /** @param serverName name of the gate MCP server (tools arrive as `<server>_<tool>`). */
  constructor(private readonly serverName: string) {}

  /** Gate tools are reported in the shared `mcp__<server>__<tool>` form, anything else as is. */
  private normalize(tool: string): string {
    const prefix = `${this.serverName}_`;
    return tool.startsWith(prefix) ? `mcp__${this.serverName}__${tool.slice(prefix.length)}` : tool;
  }

  feed(line: string): void {
    let ev: Json;
    try {
      ev = obj(JSON.parse(line));
    } catch {
      return; // log noise
    }
    if (typeof ev.sessionID === 'string') this.sessionId = ev.sessionID;
    const part = obj(ev.part);
    switch (ev.type) {
      case 'step_start':
        this.steps++;
        this.text = ''; // the answer is the text of the last step
        break;
      case 'text':
        if (typeof part.text === 'string') this.text += part.text;
        break;
      case 'tool_use': {
        const state = obj(part.state);
        const id = String(part.callID ?? part.id ?? `anon-${this.tools.size}`);
        const failed = state.status === 'error';
        const output = failed ? state.error : state.output;
        this.tools.set(id, {
          id,
          name: this.normalize(String(part.tool ?? '')),
          input: state.input ?? {},
          isError: failed,
          output: (typeof output === 'string' ? output : JSON.stringify(output ?? '')).slice(
            0,
            MAX_TOOL_OUTPUT,
          ),
        });
        break;
      }
      case 'step_finish': {
        this.finished++;
        this.cost += num(part.cost);
        const t = obj(part.tokens);
        const cache = obj(t.cache);
        this.tokensIn += num(t.input) + num(cache.read) + num(cache.write);
        this.tokensOut += num(t.output) + num(t.reasoning);
        break;
      }
      case 'error': {
        const e = obj(ev.error);
        const msg = obj(e.data).message ?? e.message ?? e.name;
        this.error = `harness reported an error: ${typeof msg === 'string' ? msg : 'unknown'}`;
        break;
      }
    }
  }

  turnCount(): number {
    return this.steps;
  }

  costUsd(): number {
    return this.cost;
  }

  finalize(exitCode: number | null): ParsedOutput {
    return {
      text: this.text,
      isError: this.error !== undefined,
      errorMessage: this.error,
      complete: exitCode === 0 && this.finished > 0,
      turns: this.steps,
      costUsd: this.cost,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      sessionId: this.sessionId,
      toolCalls: [...this.tools.values()],
    };
  }
}
