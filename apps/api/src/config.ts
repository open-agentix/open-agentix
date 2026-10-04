import {
  OaxError,
  RUNNER_KINDS,
  type RunnerKind,
  PriceTableSchema,
  isRole,
  type PriceEntry,
  type RoleBinding,
} from '@openagentix/core';
import { parseProviderConfigs, type ProviderConfig } from '@openagentix/providers';
import { ContainerRunnerConfigSchema, KubernetesJobRunnerConfigSchema } from '@openagentix/runners';
import { z } from 'zod';
import { loadDatabaseConfig, type DatabaseConfig } from './db/settings.js';

/**
 * The configuration contract of the control node and worker. Every key is an environment variable
 * (documented in docs/configuration.md, consumed by the Helm chart).
 */
const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const json = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const RoleMappingSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  OAX_HOST: z.string().default('0.0.0.0'),
  OAX_PORT: int(8080),
  OAX_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  OAX_UI_URL: z.string().url().optional(),
  OAX_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  OAX_CORS_ORIGINS: z.string().default(''),
  OAX_TRUST_PROXY: bool.default(false),

  OAX_CACHE_URL: z.string().optional(),
  OAX_CACHE_MAX_ENTRIES: int(10_000),

  OAX_RATE_LIMIT_MAX: int(600),
  OAX_RATE_LIMIT_LOGIN_MAX: int(10),
  OAX_RATE_LIMIT_PLAN_MAX: int(30),
  OAX_BODY_LIMIT_BYTES: int(1_048_576),

  OAX_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  OAX_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  OAX_SESSION_TTL_SECONDS: int(8 * 3600),
  OAX_TOKEN_MAX_TTL_DAYS: int(365),
  OAX_AUTH_CACHE_TTL_SECONDS: int(30),

  OAX_OIDC_ISSUER: z.string().url().optional(),
  OAX_OIDC_CLIENT_ID: z.string().optional(),
  OAX_OIDC_CLIENT_SECRET: z.string().optional(),
  OAX_OIDC_REDIRECT_URI: z.string().url().optional(),
  OAX_OIDC_SCOPES: z.string().default('openid profile email'),
  OAX_OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OAX_OIDC_ROLE_MAPPING: json(RoleMappingSchema).optional(),

  OAX_LDAP_URL: z.string().optional(),
  OAX_LDAP_BIND_DN: z.string().optional(),
  OAX_LDAP_BIND_PASSWORD: z.string().optional(),
  OAX_LDAP_USER_BASE_DN: z.string().optional(),
  OAX_LDAP_USER_FILTER: z.string().default('(uid={username})'),
  OAX_LDAP_GROUP_ATTRIBUTE: z.string().default('memberOf'),
  OAX_LDAP_ROLE_MAPPING: json(RoleMappingSchema).optional(),
  OAX_LDAP_TLS_REJECT_UNAUTHORIZED: bool.default(true),

  OAX_AUDIT_SIGNING_KEY: z.string().optional(),
  OAX_AUDIT_SIGNING_KEY_ID: z.string().default('default'),
  OAX_AUDIT_PUBLIC_KEYS: json(z.record(z.string(), z.string())).optional(),
  OAX_AUDIT_CHECKPOINT_EVERY: int(1000),

  OAX_RUN_TOKEN_SECRET: z.string().min(32).optional(),
  OAX_RUN_TOKEN_TTL_SECONDS: int(4 * 3600),

  OAX_PROVIDERS: z.string().optional(),
  OAX_PRICE_TABLE: json(PriceTableSchema).optional(),
  OAX_CONTROL_MAX_TOOL_CALLS_PER_MINUTE: int(30),
  OAX_DEFAULT_MAX_STEPS: int(50),
  OAX_DEFAULT_TIMEOUT_SECONDS: int(1800),

  OAX_WEBHOOK_TOLERANCE_SECONDS: int(300),
  OAX_WEBHOOK_MAX_BYTES: int(1_048_576),

  OAX_WORKER_CONCURRENCY: int(4),
  OAX_WORKER_POLL_MS: int(500),
  OAX_WORKER_LEASE_SECONDS: int(60),
  OAX_WORKER_MAX_ATTEMPTS: int(3),
  OAX_APPROVAL_POLL_MS: int(1000),
  OAX_SSE_POLL_MS: int(500),

  OAX_METRICS_TOKEN: z.string().optional(),
  OAX_WORKER_HTTP_PORT: int(9090),
  OAX_WORKER_HTTP_HOST: z.string().default('0.0.0.0'),

  OAX_SECRETS_DIR: z.string().optional(),
  OAX_DEMO_MCP: bool.default(false),
  OAX_DEMO_MODE: bool.default(false),
  OAX_DEMO_PASSWORD: z.string().min(8).default('demo-password-2026'),
  // Demo scenarios (docs/demo.md): fixed scenarios only, optionally executed by Claude Code.
  OAX_DEMO_LLM: z.enum(['simulated', 'claude-code']).default('simulated'),
  OAX_DEMO_LLM_MODEL: z.string().min(1).default('haiku'),
  /** File with a token from `claude setup-token`, mounted read-only (never an env value). */
  OAX_DEMO_LLM_TOKEN_FILE: z.string().optional(),
  OAX_DEMO_LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(1),
  OAX_DEMO_LLM_RUN_BUDGET_USD: z.coerce.number().positive().default(0.05),
  OAX_DEMO_LLM_WORKDIR: z.string().optional(),
  OAX_DEMO_RATE_RUNS: int(3),
  OAX_DEMO_RATE_WINDOW_SECONDS: int(600),
  OAX_DEMO_DAILY_RUNS: int(100),

  // Runners (v0.2; parsed and validated now, feature-flagged off).
  OAX_RUNNERS_ENABLED: z.string().default('in-process'),
  OAX_K8S_JOB_ENABLED: bool.default(false),
  OAX_K8S_NAMESPACE: z.string().default('openagentix-runs'),
  OAX_K8S_SERVICE_ACCOUNT: z.string().default('openagentix-worker'),
  OAX_K8S_TTL_SECONDS_AFTER_FINISHED: int(600),
  OAX_K8S_ACTIVE_DEADLINE_SECONDS: int(3600),
  OAX_K8S_IMAGE_PULL_SECRETS: z.string().default(''),
  OAX_K8S_NODE_SELECTOR: json(z.record(z.string(), z.string())).optional(),
  OAX_K8S_RESOURCES_CPU: z.string().default('500m'),
  OAX_K8S_RESOURCES_MEMORY: z.string().default('512Mi'),
  OAX_K8S_EGRESS: z.string().default(''),
  // Container runner (W1-3a): opt-in, one hardened container per isolated step.
  OAX_CONTAINER_RUNNER_ENABLED: bool.default(false),
  OAX_CONTAINER_ENGINE: z.enum(['docker', 'podman']).default('docker'),
  /** `unix:///run/user/1000/podman/podman.sock` or a socket proxy `http://socket-proxy:2375`. */
  OAX_CONTAINER_ENGINE_URL: z.string().optional(),
  OAX_CONTAINER_ALLOW_RAW_SOCKET: bool.default(false),
  /** Run node image pinned by digest (`...@sha256:<64 hex>`). */
  OAX_CONTAINER_IMAGE: z.string().optional(),
  OAX_CONTAINER_TOOLBOX_IMAGES: json(z.record(z.string(), z.string())).optional(),
  /** Pre-created network with `internal: true`. */
  OAX_CONTAINER_NETWORK: z.string().optional(),
  /** Egress proxy: where the worker listens and the URL nodes use. */
  OAX_CONTAINER_EGRESS_PROXY_LISTEN: z.string().optional(),
  OAX_CONTAINER_EGRESS_PROXY_URL: z.string().url().optional(),
  OAX_CONTAINER_MAX_CPUS: z.coerce.number().positive().default(1),
  OAX_CONTAINER_MAX_MEMORY_MB: int(512),
  OAX_CONTAINER_MAX_PIDS: int(256),
  /** Base URL of the control node as seen from run nodes (internal network, not the public URL). */
  OAX_NODE_CONTROL_URL: z.string().url().optional(),
  OAX_TOOLBOX_REGISTRY: z.string().default('ghcr.io/open-agentix'),
  OAX_TOOLBOX_ALLOWLIST: z.string().default(''),
  OAX_TOOLBOX_REQUIRE_SIGNATURE: bool.default(true),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),

  // Air-gapped mode (docs/airgapped.md): fail-closed egress allowlist.
  OAX_AIRGAPPED: bool.default(false),
  OAX_AIRGAPPED_ALLOW: z.string().default(''),
  /** Reserved outbound features; refused while air-gapped, checked so they cannot be enabled by mistake. */
  OAX_CATALOG_REFRESH_URL: z.string().url().optional(),
  OAX_WEBHOOK_OUT_URLS: z.string().default(''),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicUrl: string;
  uiUrl: string | undefined;
  logLevel: string;
  corsOrigins: string[];
  trustProxy: boolean;
  database: DatabaseConfig;
  cache: { url: string | undefined; maxEntries: number };
  rateLimit: { max: number; loginMax: number; planMax: number };
  bodyLimit: number;
  auth: {
    bootstrapAdmin: { email: string; password: string } | null;
    sessionTtlSeconds: number;
    tokenMaxTtlDays: number;
    cacheTtlSeconds: number;
    oidc: {
      issuer: string;
      clientId: string;
      clientSecret: string | undefined;
      redirectUri: string;
      scopes: string;
      groupsClaim: string;
      roleMapping: RoleMapping;
    } | null;
    ldap: {
      url: string;
      bindDn: string | undefined;
      bindPassword: string | undefined;
      userBaseDn: string;
      userFilter: string;
      groupAttribute: string;
      roleMapping: RoleMapping;
      tlsRejectUnauthorized: boolean;
    } | null;
  };
  audit: {
    signingKey: string | undefined;
    signingKeyId: string;
    publicKeys: Record<string, string>;
    checkpointEvery: number;
  };
  runToken: { secret: string; ttlSeconds: number };
  providers: ProviderConfig[];
  priceTable: PriceEntry[];
  control: {
    maxToolCallsPerMinute: number;
    defaultMaxSteps: number;
    defaultTimeoutSeconds: number;
  };
  webhook: { toleranceSeconds: number; maxBytes: number };
  worker: {
    concurrency: number;
    pollMs: number;
    leaseSeconds: number;
    maxAttempts: number;
    approvalPollMs: number;
  };
  ssePollMs: number;
  metricsToken: string | undefined;
  otel: { endpoint: string | undefined; serviceName: string };
  workerHttp: { host: string; port: number };
  secrets: { dir: string | undefined; envRefs: string[] };
  demoMcp: boolean;
  demo: {
    enabled: boolean;
    password: string;
    /** Who executes scenario runs: the simulated provider (default) or the Claude Code harness. */
    llm: 'simulated' | 'claude-code';
    llmModel: string;
    llmTokenFile: string | undefined;
    dailyBudgetUsd: number;
    runBudgetUsd: number;
    workDir: string | undefined;
    /** Scenario runs per visitor (IP) and window, and per day for the whole demo. */
    rate: { runs: number; windowSeconds: number };
    dailyRuns: number;
  };
  runners: {
    enabled: RunnerKind[];
    kubernetesJob: { enabled: boolean } & z.infer<typeof KubernetesJobRunnerConfigSchema> & {
        imagePullSecrets: string[];
      };
    /** `config` is set exactly when the runner is enabled and complete (fail closed otherwise). */
    container: {
      enabled: boolean;
      config?: z.infer<typeof ContainerRunnerConfigSchema>;
      /** `host:port` the worker's egress proxy listens on (when step egress is used). */
      egressProxyListen?: { host: string; port: number };
      /** Control node base URL as seen from run nodes. */
      nodeControlUrl?: string;
    };
  };
  toolboxes: { registry: string; allowlist: string[]; requireSignature: boolean };
  airgap: {
    enabled: boolean;
    /** Raw `OAX_AIRGAPPED_ALLOW` (hosts, suffixes, CIDRs). */
    allow: string;
    catalogRefreshUrl: string | undefined;
    webhookOutUrls: string[];
  };
}

/** Group/claim value -> role bindings; values are `role` (global) or `role@team-slug`. */
export type RoleMapping = Record<string, string | string[]>;

export interface MappedBinding {
  role: RoleBinding['role'];
  teamSlug: string | null;
}

export function mapGroupsToBindings(
  groups: readonly string[],
  mapping: RoleMapping,
): MappedBinding[] {
  const out = new Map<string, MappedBinding>();
  for (const g of groups) {
    const targets = mapping[g];
    if (!targets) continue;
    for (const t of Array.isArray(targets) ? targets : [targets]) {
      const [role, team] = t.split('@');
      if (!role || !isRole(role)) continue;
      out.set(`${role}@${team ?? ''}`, { role, teamSlug: team ?? null });
    }
  }
  return [...out.values()];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new OaxError('config_invalid', `invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const database = loadDatabaseConfig(env);
  if (e.NODE_ENV === 'production' && !e.OAX_RUN_TOKEN_SECRET) {
    throw new OaxError(
      'config_invalid',
      'OAX_RUN_TOKEN_SECRET (>= 32 chars) is required in production',
    );
  }
  if (e.OAX_DEMO_LLM === 'claude-code' && !e.OAX_DEMO_MODE) {
    throw new OaxError(
      'config_invalid',
      'invalid configuration: OAX_DEMO_LLM=claude-code requires OAX_DEMO_MODE=true (fixed scenarios only)',
    );
  }
  const oidcConfigured = e.OAX_OIDC_ISSUER && e.OAX_OIDC_CLIENT_ID && e.OAX_OIDC_REDIRECT_URI;
  return {
    env: e.NODE_ENV,
    host: e.OAX_HOST,
    port: e.OAX_PORT,
    publicUrl: e.OAX_PUBLIC_URL.replace(/\/$/, ''),
    uiUrl: e.OAX_UI_URL,
    logLevel: e.OAX_LOG_LEVEL,
    corsOrigins: e.OAX_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: e.OAX_TRUST_PROXY,
    database,
    cache: { url: e.OAX_CACHE_URL, maxEntries: e.OAX_CACHE_MAX_ENTRIES },
    rateLimit: {
      max: e.OAX_RATE_LIMIT_MAX,
      loginMax: e.OAX_RATE_LIMIT_LOGIN_MAX,
      planMax: e.OAX_RATE_LIMIT_PLAN_MAX,
    },
    bodyLimit: e.OAX_BODY_LIMIT_BYTES,
    auth: {
      bootstrapAdmin:
        e.OAX_BOOTSTRAP_ADMIN_EMAIL && e.OAX_BOOTSTRAP_ADMIN_PASSWORD
          ? { email: e.OAX_BOOTSTRAP_ADMIN_EMAIL, password: e.OAX_BOOTSTRAP_ADMIN_PASSWORD }
          : null,
      sessionTtlSeconds: e.OAX_SESSION_TTL_SECONDS,
      tokenMaxTtlDays: e.OAX_TOKEN_MAX_TTL_DAYS,
      cacheTtlSeconds: e.OAX_AUTH_CACHE_TTL_SECONDS,
      oidc: oidcConfigured
        ? {
            issuer: e.OAX_OIDC_ISSUER!,
            clientId: e.OAX_OIDC_CLIENT_ID!,
            clientSecret: e.OAX_OIDC_CLIENT_SECRET,
            redirectUri: e.OAX_OIDC_REDIRECT_URI!,
            scopes: e.OAX_OIDC_SCOPES,
            groupsClaim: e.OAX_OIDC_GROUPS_CLAIM,
            roleMapping: e.OAX_OIDC_ROLE_MAPPING ?? {},
          }
        : null,
      ldap:
        e.OAX_LDAP_URL && e.OAX_LDAP_USER_BASE_DN
          ? {
              url: e.OAX_LDAP_URL,
              bindDn: e.OAX_LDAP_BIND_DN,
              bindPassword: e.OAX_LDAP_BIND_PASSWORD,
              userBaseDn: e.OAX_LDAP_USER_BASE_DN,
              userFilter: e.OAX_LDAP_USER_FILTER,
              groupAttribute: e.OAX_LDAP_GROUP_ATTRIBUTE,
              roleMapping: e.OAX_LDAP_ROLE_MAPPING ?? {},
              tlsRejectUnauthorized: e.OAX_LDAP_TLS_REJECT_UNAUTHORIZED,
            }
          : null,
    },
    audit: {
      signingKey: e.OAX_AUDIT_SIGNING_KEY,
      signingKeyId: e.OAX_AUDIT_SIGNING_KEY_ID,
      publicKeys: e.OAX_AUDIT_PUBLIC_KEYS ?? {},
      checkpointEvery: e.OAX_AUDIT_CHECKPOINT_EVERY,
    },
    // Development fallback only; production requires an explicit secret (checked above).
    runToken: {
      secret: e.OAX_RUN_TOKEN_SECRET ?? 'development-only-run-token-secret-change-me',
      ttlSeconds: e.OAX_RUN_TOKEN_TTL_SECONDS,
    },
    providers: parseProviderConfigs(e.OAX_PROVIDERS),
    priceTable: e.OAX_PRICE_TABLE ?? [],
    control: {
      maxToolCallsPerMinute: e.OAX_CONTROL_MAX_TOOL_CALLS_PER_MINUTE,
      defaultMaxSteps: e.OAX_DEFAULT_MAX_STEPS,
      defaultTimeoutSeconds: e.OAX_DEFAULT_TIMEOUT_SECONDS,
    },
    webhook: {
      toleranceSeconds: e.OAX_WEBHOOK_TOLERANCE_SECONDS,
      maxBytes: e.OAX_WEBHOOK_MAX_BYTES,
    },
    worker: {
      concurrency: Math.max(1, e.OAX_WORKER_CONCURRENCY),
      pollMs: Math.max(50, e.OAX_WORKER_POLL_MS),
      leaseSeconds: Math.max(10, e.OAX_WORKER_LEASE_SECONDS),
      maxAttempts: Math.max(1, e.OAX_WORKER_MAX_ATTEMPTS),
      approvalPollMs: Math.max(10, e.OAX_APPROVAL_POLL_MS),
    },
    ssePollMs: Math.max(50, e.OAX_SSE_POLL_MS),
    metricsToken: e.OAX_METRICS_TOKEN,
    otel: {
      endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: e.OTEL_SERVICE_NAME ?? 'openagentix-api',
    },
    workerHttp: { host: e.OAX_WORKER_HTTP_HOST, port: e.OAX_WORKER_HTTP_PORT },
    secrets: { dir: e.OAX_SECRETS_DIR, envRefs: secretEnvRefs(env) },
    demoMcp: e.OAX_DEMO_MCP,
    demo: {
      enabled: e.OAX_DEMO_MODE,
      password: e.OAX_DEMO_PASSWORD,
      llm: e.OAX_DEMO_LLM,
      llmModel: e.OAX_DEMO_LLM_MODEL,
      llmTokenFile: e.OAX_DEMO_LLM_TOKEN_FILE,
      dailyBudgetUsd: e.OAX_DEMO_LLM_DAILY_BUDGET_USD,
      runBudgetUsd: e.OAX_DEMO_LLM_RUN_BUDGET_USD,
      workDir: e.OAX_DEMO_LLM_WORKDIR,
      rate: { runs: e.OAX_DEMO_RATE_RUNS, windowSeconds: e.OAX_DEMO_RATE_WINDOW_SECONDS },
      dailyRuns: e.OAX_DEMO_DAILY_RUNS,
    },
    runners: runnersConfig(e),
    toolboxes: {
      registry: e.OAX_TOOLBOX_REGISTRY,
      allowlist: list(e.OAX_TOOLBOX_ALLOWLIST),
      requireSignature: e.OAX_TOOLBOX_REQUIRE_SIGNATURE,
    },
    airgap: {
      enabled: e.OAX_AIRGAPPED,
      allow: e.OAX_AIRGAPPED_ALLOW,
      catalogRefreshUrl: e.OAX_CATALOG_REFRESH_URL,
      webhookOutUrls: list(e.OAX_WEBHOOK_OUT_URLS),
    },
  };
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Names of `OAX_SECRET_<NAME>` variables (values stay in the environment). */
export function secretEnvRefs(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('OAX_SECRET_') || key === 'OAX_SECRETS_DIR') continue;
    const name = key.slice('OAX_SECRET_'.length);
    if (!/^[A-Z0-9_]{1,128}$/.test(name)) {
      throw new OaxError(
        'config_invalid',
        `invalid configuration: ${key} must match OAX_SECRET_[A-Z0-9_]+`,
      );
    }
    out.push(name.toLowerCase());
  }
  return out.sort();
}

function containerConfig(e: z.infer<typeof EnvSchema>): Config['runners']['container'] {
  if (!e.OAX_CONTAINER_RUNNER_ENABLED) return { enabled: false };
  const need = (value: string | undefined, name: string): string => {
    if (!value)
      throw new OaxError(
        'config_invalid',
        `invalid configuration: ${name} is required when OAX_CONTAINER_RUNNER_ENABLED=true`,
      );
    return value;
  };
  const listen = e.OAX_CONTAINER_EGRESS_PROXY_LISTEN;
  let egressProxyListen: { host: string; port: number } | undefined;
  if (listen) {
    const m = /^(.+):(\d{1,5})$/.exec(listen);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535)
      throw new OaxError(
        'config_invalid',
        'invalid configuration: OAX_CONTAINER_EGRESS_PROXY_LISTEN must be host:port',
      );
    egressProxyListen = { host: m[1]!, port: Number(m[2]) };
  }
  if (!!listen !== !!e.OAX_CONTAINER_EGRESS_PROXY_URL)
    throw new OaxError(
      'config_invalid',
      'invalid configuration: set both OAX_CONTAINER_EGRESS_PROXY_LISTEN and OAX_CONTAINER_EGRESS_PROXY_URL, or neither (no step egress)',
    );
  const parsed = ContainerRunnerConfigSchema.safeParse({
    engine: e.OAX_CONTAINER_ENGINE,
    engineUrl: need(e.OAX_CONTAINER_ENGINE_URL, 'OAX_CONTAINER_ENGINE_URL'),
    allowRawSocket: e.OAX_CONTAINER_ALLOW_RAW_SOCKET,
    image: need(e.OAX_CONTAINER_IMAGE, 'OAX_CONTAINER_IMAGE'),
    toolboxImages: e.OAX_CONTAINER_TOOLBOX_IMAGES ?? {},
    network: need(e.OAX_CONTAINER_NETWORK, 'OAX_CONTAINER_NETWORK'),
    ...(e.OAX_CONTAINER_EGRESS_PROXY_URL
      ? { egressProxyUrl: e.OAX_CONTAINER_EGRESS_PROXY_URL }
      : {}),
    maxCpus: e.OAX_CONTAINER_MAX_CPUS,
    maxMemoryMb: e.OAX_CONTAINER_MAX_MEMORY_MB,
    maxPids: e.OAX_CONTAINER_MAX_PIDS,
  });
  if (!parsed.success)
    throw new OaxError(
      'config_invalid',
      `invalid configuration: container runner: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return {
    enabled: true,
    config: parsed.data,
    ...(egressProxyListen ? { egressProxyListen } : {}),
    nodeControlUrl: need(e.OAX_NODE_CONTROL_URL, 'OAX_NODE_CONTROL_URL'),
  };
}

function runnersConfig(e: z.infer<typeof EnvSchema>): Config['runners'] {
  const enabled = list(e.OAX_RUNNERS_ENABLED);
  for (const r of enabled) {
    if (!(RUNNER_KINDS as readonly string[]).includes(r)) {
      throw new OaxError(
        'config_invalid',
        `invalid configuration: OAX_RUNNERS_ENABLED contains unknown runner "${r}"`,
      );
    }
  }
  const job = KubernetesJobRunnerConfigSchema.parse({
    namespace: e.OAX_K8S_NAMESPACE,
    serviceAccountName: e.OAX_K8S_SERVICE_ACCOUNT,
    registry: e.OAX_TOOLBOX_REGISTRY,
    ttlSecondsAfterFinished: e.OAX_K8S_TTL_SECONDS_AFTER_FINISHED,
    activeDeadlineSeconds: e.OAX_K8S_ACTIVE_DEADLINE_SECONDS,
    egress: list(e.OAX_K8S_EGRESS),
    resources: { cpu: e.OAX_K8S_RESOURCES_CPU, memory: e.OAX_K8S_RESOURCES_MEMORY },
    nodeSelector: e.OAX_K8S_NODE_SELECTOR ?? {},
  });
  if (enabled.includes('kubernetes-job') && !e.OAX_K8S_JOB_ENABLED) {
    throw new OaxError(
      'config_invalid',
      'invalid configuration: runner "kubernetes-job" requires OAX_K8S_JOB_ENABLED=true (v0.2 feature flag)',
    );
  }
  const container = containerConfig(e);
  if (enabled.includes('container') && !container.enabled) {
    throw new OaxError(
      'config_invalid',
      'invalid configuration: runner "container" requires OAX_CONTAINER_RUNNER_ENABLED=true',
    );
  }
  return {
    enabled: enabled as RunnerKind[],
    container,
    kubernetesJob: {
      enabled: e.OAX_K8S_JOB_ENABLED,
      ...job,
      imagePullSecrets: list(e.OAX_K8S_IMAGE_PULL_SECRETS),
    },
  };
}
