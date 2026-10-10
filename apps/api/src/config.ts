import {
  OaxError,
  HARNESS_KINDS,
  RUNNER_KINDS,
  type HarnessKind,
  type RunnerKind,
  PriceTableSchema,
  isGrantableRole,
  type PriceEntry,
  type RoleBinding,
} from '@openagentix/core';
import { parseProviderConfigs, type ProviderConfig } from '@openagentix/providers';
import {
  ContainerRunnerConfigSchema,
  KubernetesJobRunnerConfigSchema,
  parseCidr,
  parseEgressEntries,
  validateControlPlane,
  validateImage,
  validateResourceCeiling,
} from '@openagentix/runners';
import { z } from 'zod';
import { OTEL_ENV_SHAPE, buildOtelConfig, type OtelConfig } from './telemetry-config.js';
import { loadDatabaseConfig, type DatabaseConfig } from './db/settings.js';

/**
 * The configuration contract of the control node and worker. Every key is an environment variable
 * (documented in docs/configuration.md, consumed by the Helm chart).
 */
const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
// Upper bound: a value this large is a typo or an overflow, never a real limit (2^31 - 1).
const int = (def: number) => z.coerce.number().int().nonnegative().max(2_147_483_647).default(def);
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
  OAX_TENANT_MAX_DEPTH: z.coerce.number().int().min(1).max(32).default(32),
  OAX_TENANT_MAX_NODES_PER_ROOT: z.coerce.number().int().min(1).default(1000),
  OAX_AUTH_CACHE_TTL_SECONDS: int(30),
  /**
   * Which source authorises (ADR 0014 S2): `legacy` = users.global_roles, team memberships and
   * agent bindings at the home node (today's behaviour); `bindings` = the tenant role resolver over
   * tenant_role_bindings at the acting node. Any other value refuses to start.
   */
  OAX_ROLE_BINDINGS_READ: z.enum(['legacy', 'bindings']).default('legacy'),
  OAX_ROLE_BINDINGS_SHADOW: bool.default(true),
  OAX_ROLE_BINDINGS_RECONCILE: bool.default(true),
  OAX_ROLE_BINDINGS_RECONCILE_INTERVAL_SECONDS: int(3600),

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
  OAX_K8S_SERVICE_ACCOUNT: z.string().default('openagentix-run-node'),
  OAX_K8S_WORKER_SERVICE_ACCOUNT: z.string().default('openagentix-worker'),
  OAX_K8S_WORKER_NAMESPACE: z.string().optional(),
  OAX_K8S_RUN_NODE_IMAGES: z.string().default(''),
  OAX_K8S_DENY_CIDRS: z.string().default(''),
  OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION: bool.default(false),
  OAX_K8S_TTL_SECONDS_AFTER_FINISHED: int(600),
  OAX_K8S_ACTIVE_DEADLINE_SECONDS: int(3600),
  OAX_K8S_IMAGE_PULL_SECRETS: z.string().default(''),
  OAX_K8S_NODE_SELECTOR: json(z.record(z.string(), z.string())).optional(),
  OAX_K8S_RESOURCES_CPU: z.string().default('500m'),
  OAX_K8S_RESOURCES_MEMORY: z.string().default('512Mi'),
  OAX_K8S_EGRESS: z.string().default(''),
  OAX_K8S_IMAGE: z.string().optional(),
  OAX_K8S_TOOLBOX_IMAGES: json(z.record(z.string(), z.string())).optional(),
  OAX_K8S_CONTROL_PLANE_POD_SELECTOR: json(z.record(z.string(), z.string())).optional(),
  OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR: json(z.record(z.string(), z.string())).optional(),
  OAX_K8S_CONTROL_PLANE_CIDRS: z.string().default(''),
  OAX_K8S_CONTROL_PLANE_PORTS: z.string().default('443'),
  OAX_K8S_DNS_EGRESS: bool.default(true),
  OAX_K8S_AUTOMOUNT_SA_TOKEN: bool.default(false),
  OAX_K8S_DEFAULT_DENY_POLICY: z.string().default('default-deny-all'),
  // Container runner (W1-3a): opt-in, one hardened container per isolated step.
  OAX_CONTAINER_RUNNER_ENABLED: bool.default(false),
  OAX_CONTAINER_ENGINE: z.enum(['docker', 'podman']).default('docker'),
  /** `unix:///run/user/1000/podman/podman.sock` or a socket proxy `http://socket-proxy:2375`. */
  OAX_CONTAINER_ENGINE_URL: z.string().optional(),
  OAX_CONTAINER_ALLOW_RAW_SOCKET: bool.default(false),
  /** Run node image pinned by digest (`...@sha256:<64 hex>`). */
  OAX_CONTAINER_IMAGE: z.string().optional(),
  OAX_CONTAINER_TOOLBOX_IMAGES: json(z.record(z.string(), z.string())).optional(),
  /** Harness -> digest-pinned image, e.g. `{"claude-code":"ghcr.io/...@sha256:..."}` (DOG-1). */
  OAX_CONTAINER_HARNESS_IMAGES: json(z.record(z.string(), z.string())).optional(),
  /** Memory (MiB) of an ordinary run node; clamped to OAX_CONTAINER_MAX_MEMORY_MB (the ceiling, not the default). */
  OAX_CONTAINER_MEMORY_MB: int(512),
  /** `/tmp` tmpfs size (MiB) of an ordinary run node; at most half of the node memory. */
  OAX_CONTAINER_TMP_MB: int(64),
  /** Memory (MiB, clamped to OAX_CONTAINER_MAX_MEMORY_MB) and `/tmp` size (MiB) of a harness step's node. */
  OAX_CONTAINER_HARNESS_MEMORY_MB: int(2048),
  OAX_CONTAINER_HARNESS_TMP_MB: int(256),
  /** Allow harness steps to declare egress hosts. Default false: a harness step reaches the control node only. */
  OAX_HARNESS_EGRESS_ALLOWED: bool.default(false),
  /** Pre-created network with `internal: true`. */
  OAX_CONTAINER_NETWORK: z.string().optional(),
  /** Egress proxy (a separate service, see docs/runners.md): URL nodes use and the shared grant key. */
  OAX_CONTAINER_EGRESS_PROXY_URL: z.string().url().optional(),
  OAX_CONTAINER_EGRESS_GRANT_SECRET: z.string().min(32).optional(),
  /** Operator upper bound for step egress (intersection with what agents.md declares). */
  OAX_CONTAINER_EGRESS_ALLOW: z.string().default(''),
  /** Private ranges (CIDRs) steps may reach where a rule matches; proxy-side, validated here. */
  OAX_CONTAINER_EGRESS_PRIVATE_ALLOW: z.string().default(''),
  OAX_CONTAINER_INSTANCE_ID: z.string().default('default'),
  OAX_CONTAINER_MAX_CPUS: z.coerce.number().positive().default(1),
  OAX_CONTAINER_MAX_MEMORY_MB: int(512),
  OAX_CONTAINER_MAX_PIDS: int(256),
  /** Base URL of the control node as seen from run nodes (internal network, not the public URL). */
  OAX_NODE_CONTROL_URL: z.string().url().optional(),
  OAX_TOOLBOX_REGISTRY: z.string().default('ghcr.io/open-agentix'),
  OAX_TOOLBOX_ALLOWLIST: z.string().default(''),
  OAX_TOOLBOX_REQUIRE_SIGNATURE: bool.default(true),
  // Model proxy (W1-3b, ADR 0009): opt-in; with it off the model routes answer 503.
  OAX_MODEL_PROXY_ENABLED: bool.default(false),
  /** Harnesses a step may name in `runtime.harness` (ADR 0009 section 10); empty = none. */
  OAX_HARNESSES_ENABLED: z.string().default(''),
  OAX_MODEL_PROXY_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(8 * 1024 * 1024),
  OAX_MODEL_PROXY_RESERVATION: z.enum(['upper-bound', 'estimate']).default('upper-bound'),
  OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(256),
  OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION: z.coerce.number().int().min(1).default(2),
  OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT: z.coerce.number().int().min(1).default(16),
  OAX_MODEL_PROXY_MAX_STREAMS: z.coerce.number().int().min(1).default(256),
  OAX_MODEL_PROXY_CALLS_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  OAX_MODEL_PROXY_MAX_CALL_SECONDS: z.coerce.number().int().min(1).default(600),
  OAX_MODEL_PROXY_TTFB_SECONDS: z.coerce.number().int().min(1).default(120),
  OAX_MODEL_PROXY_IDLE_SECONDS: z.coerce.number().int().min(1).default(60),
  OAX_MODEL_PROXY_GRACE_SECONDS: int(60),
  OAX_MODEL_PROXY_REVOCATION_POLL_MS: z.coerce.number().int().min(10).default(2000),
  OAX_MODEL_PROXY_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(16 * 1024 * 1024),
  OAX_MODEL_PROXY_CAPTURE: z.enum(['metadata', 'off']).default('metadata'),
  /** Private destinations tenant-controlled endpoints may reach (hosts, suffixes, CIDRs). */
  OAX_MODEL_PROXY_PRIVATE_ALLOW: z.string().default(''),
  /** `anthropic-beta` values a pass-through client may pass on (default: none). */
  OAX_MODEL_PROXY_ANTHROPIC_BETAS: z.string().default(''),
  ...OTEL_ENV_SHAPE,

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
  /** Tenant tree guards (ADR 0013): levels below a root (1 to 32) and nodes per organisation. */
  tenancy: { maxDepth: number; maxNodesPerRoot: number };
  auth: {
    bootstrapAdmin: { email: string; password: string } | null;
    sessionTtlSeconds: number;
    tokenMaxTtlDays: number;
    cacheTtlSeconds: number;
    /** Compare the tenant role resolver with the legacy bindings (ADR 0014 S1); result unused. */
    roleBindingsRead: 'legacy' | 'bindings';
    roleBindingsShadow: boolean;
    /** Reconcile the bindings mirror at start-up and periodically (ADR 0014 S1, #216). */
    roleBindingsReconcile: boolean;
    /** Seconds between periodic reconciles; 0 = at start-up only. */
    roleBindingsReconcileIntervalSeconds: number;
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
  otel: OtelConfig;
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
  /** External harnesses steps may run through the model proxy. Needs the model proxy. */
  harnesses: { enabled: HarnessKind[]; egressAllowed: boolean };
  runners: {
    enabled: RunnerKind[];
    kubernetesJob: { enabled: boolean } & z.infer<typeof KubernetesJobRunnerConfigSchema> & {
        imagePullSecrets: string[];
        /** Control node base URL as seen from run Pods (https only; set exactly when enabled). */
        nodeControlUrl?: string;
      };
    /** `config` is set exactly when the runner is enabled and complete (fail closed otherwise). */
    container: {
      enabled: boolean;
      config?: z.infer<typeof ContainerRunnerConfigSchema>;
      /** Control node base URL as seen from run nodes. */
      nodeControlUrl?: string;
    };
  };
  toolboxes: { registry: string; allowlist: string[]; requireSignature: boolean };
  /** Model proxy (ADR 0009). The accounting limits and the stream limits are bound from here. */
  modelProxy: {
    enabled: boolean;
    maxBodyBytes: number;
    reservation: 'upper-bound' | 'estimate';
    minOutputTokens: number;
    maxConcurrentPerSession: number;
    maxConcurrentPerTenant: number;
    maxStreams: number;
    callsPerMinute: number;
    maxCallSeconds: number;
    ttfbSeconds: number;
    idleSeconds: number;
    graceSeconds: number;
    revocationPollMs: number;
    maxResponseBytes: number;
    capture: 'metadata' | 'off';
    /** Operator allowlist of private destinations for tenant-controlled endpoints. */
    privateAllow: string[];
    /** `anthropic-beta` values the Anthropic pass-through surface forwards (allowlist). */
    anthropicBetas: string[];
  };
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
      if (!role || !isGrantableRole(role)) continue;
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
    tenancy: {
      maxDepth: e.OAX_TENANT_MAX_DEPTH,
      maxNodesPerRoot: e.OAX_TENANT_MAX_NODES_PER_ROOT,
    },
    auth: {
      bootstrapAdmin:
        e.OAX_BOOTSTRAP_ADMIN_EMAIL && e.OAX_BOOTSTRAP_ADMIN_PASSWORD
          ? { email: e.OAX_BOOTSTRAP_ADMIN_EMAIL, password: e.OAX_BOOTSTRAP_ADMIN_PASSWORD }
          : null,
      sessionTtlSeconds: e.OAX_SESSION_TTL_SECONDS,
      tokenMaxTtlDays: e.OAX_TOKEN_MAX_TTL_DAYS,
      cacheTtlSeconds: e.OAX_AUTH_CACHE_TTL_SECONDS,
      roleBindingsRead: e.OAX_ROLE_BINDINGS_READ,
      roleBindingsShadow: e.OAX_ROLE_BINDINGS_SHADOW,
      roleBindingsReconcile: e.OAX_ROLE_BINDINGS_RECONCILE,
      roleBindingsReconcileIntervalSeconds: e.OAX_ROLE_BINDINGS_RECONCILE_INTERVAL_SECONDS,
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
    otel: buildOtelConfig(e, 'openagentix-api', env),
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
    harnesses: harnessesConfig(e),
    toolboxes: {
      registry: e.OAX_TOOLBOX_REGISTRY,
      allowlist: list(e.OAX_TOOLBOX_ALLOWLIST),
      requireSignature: e.OAX_TOOLBOX_REQUIRE_SIGNATURE,
    },
    modelProxy: {
      enabled: e.OAX_MODEL_PROXY_ENABLED,
      maxBodyBytes: e.OAX_MODEL_PROXY_MAX_BODY_BYTES,
      reservation: e.OAX_MODEL_PROXY_RESERVATION,
      minOutputTokens: e.OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS,
      maxConcurrentPerSession: e.OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION,
      maxConcurrentPerTenant: e.OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT,
      maxStreams: e.OAX_MODEL_PROXY_MAX_STREAMS,
      callsPerMinute: e.OAX_MODEL_PROXY_CALLS_PER_MINUTE,
      maxCallSeconds: e.OAX_MODEL_PROXY_MAX_CALL_SECONDS,
      ttfbSeconds: e.OAX_MODEL_PROXY_TTFB_SECONDS,
      idleSeconds: e.OAX_MODEL_PROXY_IDLE_SECONDS,
      graceSeconds: e.OAX_MODEL_PROXY_GRACE_SECONDS,
      revocationPollMs: e.OAX_MODEL_PROXY_REVOCATION_POLL_MS,
      maxResponseBytes: e.OAX_MODEL_PROXY_MAX_RESPONSE_BYTES,
      capture: e.OAX_MODEL_PROXY_CAPTURE,
      privateAllow: list(e.OAX_MODEL_PROXY_PRIVATE_ALLOW),
      anthropicBetas: list(e.OAX_MODEL_PROXY_ANTHROPIC_BETAS).filter((b) =>
        /^[a-z0-9._-]{1,64}$/.test(b),
      ),
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
  // The grant secret signs egress grants; it must not be the run token secret (one leak, two keys).
  // It is only ever needed by the worker: the control node does not receive it (the runner refuses a
  // proxy URL without it at worker start).
  if (
    e.OAX_CONTAINER_EGRESS_GRANT_SECRET &&
    e.OAX_CONTAINER_EGRESS_GRANT_SECRET === e.OAX_RUN_TOKEN_SECRET
  )
    throw new OaxError(
      'config_invalid',
      'invalid configuration: OAX_CONTAINER_EGRESS_GRANT_SECRET must differ from OAX_RUN_TOKEN_SECRET',
    );
  for (const c of list(e.OAX_CONTAINER_EGRESS_PRIVATE_ALLOW))
    if (!parseCidr(c))
      throw new OaxError(
        'config_invalid',
        `invalid configuration: OAX_CONTAINER_EGRESS_PRIVATE_ALLOW entry "${c}" is not a CIDR`,
      );
  try {
    parseEgressEntries(list(e.OAX_CONTAINER_EGRESS_ALLOW));
  } catch (err) {
    throw new OaxError(
      'config_invalid',
      `invalid configuration: OAX_CONTAINER_EGRESS_ALLOW: ${(err as Error).message}`,
    );
  }
  const parsed = ContainerRunnerConfigSchema.safeParse({
    engine: e.OAX_CONTAINER_ENGINE,
    engineUrl: need(e.OAX_CONTAINER_ENGINE_URL, 'OAX_CONTAINER_ENGINE_URL'),
    allowRawSocket: e.OAX_CONTAINER_ALLOW_RAW_SOCKET,
    image: need(e.OAX_CONTAINER_IMAGE, 'OAX_CONTAINER_IMAGE'),
    toolboxImages: e.OAX_CONTAINER_TOOLBOX_IMAGES ?? {},
    harnessImages: e.OAX_CONTAINER_HARNESS_IMAGES ?? {},
    memoryMb: e.OAX_CONTAINER_MEMORY_MB,
    tmpMb: e.OAX_CONTAINER_TMP_MB,
    harnessMemoryMb: e.OAX_CONTAINER_HARNESS_MEMORY_MB,
    harnessTmpMb: e.OAX_CONTAINER_HARNESS_TMP_MB,
    harnessEgressAllowed: e.OAX_HARNESS_EGRESS_ALLOWED,
    network: need(e.OAX_CONTAINER_NETWORK, 'OAX_CONTAINER_NETWORK'),
    ...(e.OAX_CONTAINER_EGRESS_PROXY_URL
      ? {
          egressProxyUrl: e.OAX_CONTAINER_EGRESS_PROXY_URL,
          ...(e.OAX_CONTAINER_EGRESS_GRANT_SECRET
            ? { egressGrantSecret: e.OAX_CONTAINER_EGRESS_GRANT_SECRET }
            : {}),
        }
      : {}),
    egressAllow: list(e.OAX_CONTAINER_EGRESS_ALLOW),
    instanceId: e.OAX_CONTAINER_INSTANCE_ID,
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
    nodeControlUrl: need(e.OAX_NODE_CONTROL_URL, 'OAX_NODE_CONTROL_URL'),
  };
}

function harnessesConfig(e: z.infer<typeof EnvSchema>): Config['harnesses'] {
  const enabled = list(e.OAX_HARNESSES_ENABLED);
  for (const h of enabled) {
    if (!(HARNESS_KINDS as readonly string[]).includes(h))
      throw new OaxError(
        'config_invalid',
        `invalid configuration: OAX_HARNESSES_ENABLED contains unknown harness "${h}"`,
      );
  }
  // A harness never holds a provider key: without the proxy it has no model to talk to.
  if (enabled.length > 0 && !e.OAX_MODEL_PROXY_ENABLED)
    throw new OaxError(
      'config_invalid',
      'invalid configuration: OAX_HARNESSES_ENABLED requires OAX_MODEL_PROXY_ENABLED=true',
    );
  return {
    enabled: [...new Set(enabled)] as HarnessKind[],
    egressAllowed: e.OAX_HARNESS_EGRESS_ALLOWED,
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
  // An empty list would become `ports: []` in the NetworkPolicy, which Kubernetes reads as
  // "every port"; refuse it (and non-numeric entries) with the setting's name.
  const controlPlanePorts = list(e.OAX_K8S_CONTROL_PLANE_PORTS).map(Number);
  if (
    controlPlanePorts.length === 0 ||
    !controlPlanePorts.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)
  ) {
    throw new OaxError(
      'config_invalid',
      'invalid configuration: OAX_K8S_CONTROL_PLANE_PORTS must list at least one TCP port (1-65535)',
    );
  }
  const job = KubernetesJobRunnerConfigSchema.parse({
    namespace: e.OAX_K8S_NAMESPACE,
    serviceAccountName: e.OAX_K8S_SERVICE_ACCOUNT,
    workerServiceAccount: e.OAX_K8S_WORKER_SERVICE_ACCOUNT,
    ...(e.OAX_K8S_WORKER_NAMESPACE ? { workerNamespace: e.OAX_K8S_WORKER_NAMESPACE } : {}),
    registry: e.OAX_TOOLBOX_REGISTRY,
    toolboxAllowlist: list(e.OAX_TOOLBOX_ALLOWLIST),
    runNodeImages: list(e.OAX_K8S_RUN_NODE_IMAGES),
    denyCidrs: list(e.OAX_K8S_DENY_CIDRS),
    airgapped: e.OAX_AIRGAPPED,
    ttlSecondsAfterFinished: e.OAX_K8S_TTL_SECONDS_AFTER_FINISHED,
    activeDeadlineSeconds: e.OAX_K8S_ACTIVE_DEADLINE_SECONDS,
    egress: list(e.OAX_K8S_EGRESS),
    resources: { cpu: e.OAX_K8S_RESOURCES_CPU, memory: e.OAX_K8S_RESOURCES_MEMORY },
    nodeSelector: e.OAX_K8S_NODE_SELECTOR ?? {},
    ...(e.OAX_K8S_IMAGE ? { image: e.OAX_K8S_IMAGE } : {}),
    toolboxImages: e.OAX_K8S_TOOLBOX_IMAGES ?? {},
    controlPlane: {
      ...(e.OAX_K8S_CONTROL_PLANE_POD_SELECTOR
        ? { podSelector: e.OAX_K8S_CONTROL_PLANE_POD_SELECTOR }
        : {}),
      ...(e.OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR
        ? { namespaceSelector: e.OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR }
        : {}),
      cidrs: list(e.OAX_K8S_CONTROL_PLANE_CIDRS),
      ports: controlPlanePorts,
    },
    dnsEgress: e.OAX_K8S_DNS_EGRESS,
    automountServiceAccountToken: e.OAX_K8S_AUTOMOUNT_SA_TOKEN,
    defaultDenyPolicy: e.OAX_K8S_DEFAULT_DENY_POLICY,
  });
  try {
    validateResourceCeiling(job.resources);
  } catch (err) {
    throw new OaxError(
      'config_invalid',
      `invalid configuration: OAX_K8S_RESOURCES_*: ${(err as Error).message}`,
    );
  }
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
  if (enabled.includes('kubernetes-job')) {
    // Fail closed: without an allowlist the runner would start no image at all.
    if (job.toolboxAllowlist.length === 0 && job.runNodeImages.length === 0) {
      throw new OaxError(
        'config_invalid',
        'invalid configuration: runner "kubernetes-job" needs OAX_TOOLBOX_ALLOWLIST and/or OAX_K8S_RUN_NODE_IMAGES (an empty allowlist would allow nothing)',
      );
    }
    // Fail closed: a Pod that cannot reach the control node is useless, and the control node URL
    // must be https (the run token travels to it).
    const cp = job.controlPlane;
    if (!cp.podSelector && !cp.namespaceSelector && cp.cidrs.length === 0) {
      throw new OaxError(
        'config_invalid',
        'invalid configuration: runner "kubernetes-job" needs OAX_K8S_CONTROL_PLANE_POD_SELECTOR / OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR / OAX_K8S_CONTROL_PLANE_CIDRS (where run nodes may reach the control node)',
      );
    }
    try {
      validateControlPlane(job);
    } catch (err) {
      throw new OaxError(
        'config_invalid',
        `invalid configuration: OAX_K8S_CONTROL_PLANE_CIDRS / OAX_K8S_DENY_CIDRS: ${(err as Error).message}`,
      );
    }
    if (!e.OAX_NODE_CONTROL_URL || !e.OAX_NODE_CONTROL_URL.startsWith('https://')) {
      throw new OaxError(
        'config_invalid',
        'invalid configuration: runner "kubernetes-job" needs OAX_NODE_CONTROL_URL with an https:// URL',
      );
    }
    if (!job.image) {
      throw new OaxError(
        'config_invalid',
        'invalid configuration: runner "kubernetes-job" needs OAX_K8S_IMAGE (digest-pinned run node image)',
      );
    }
    for (const image of [job.image, ...Object.values(job.toolboxImages)]) {
      try {
        validateImage(image!, job);
      } catch (err) {
        throw new OaxError(
          'config_invalid',
          `invalid configuration: OAX_K8S_IMAGE / OAX_K8S_TOOLBOX_IMAGES: ${(err as Error).message}`,
        );
      }
    }
    // The runner does not verify cosign signatures itself; an admission policy must.
    if (e.OAX_TOOLBOX_REQUIRE_SIGNATURE && !e.OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION) {
      throw new OaxError(
        'config_invalid',
        'invalid configuration: OAX_TOOLBOX_REQUIRE_SIGNATURE=true is not enforced by the kubernetes-job runner itself; verify signatures with an admission policy (Kyverno/policy-controller) and set OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION=true, or set OAX_TOOLBOX_REQUIRE_SIGNATURE=false',
      );
    }
  }
  return {
    enabled: enabled as RunnerKind[],
    container,
    kubernetesJob: {
      enabled: e.OAX_K8S_JOB_ENABLED,
      ...job,
      imagePullSecrets: list(e.OAX_K8S_IMAGE_PULL_SECRETS),
      ...(e.OAX_NODE_CONTROL_URL ? { nodeControlUrl: e.OAX_NODE_CONTROL_URL } : {}),
    },
  };
}
