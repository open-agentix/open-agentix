import { NotImplementedError, type RunnerKind } from '@openagentix/core';
import { z } from 'zod';
import type { PreparedRun, RunResult, Runner, RunnerContext } from './types.js';

/**
 * Typed, documented stubs for remote runners (the Kubernetes Job runner is real, see kubernetes-job.ts). Their configuration schemas are final enough to be
 * used by the Helm chart and UI; execution lands in v0.2 (container, Kubernetes Job) and v0.3
 * (AWS Lambda, GitHub Actions, GitLab CI). See docs/adr/0005-runners-and-external-harnesses.md.
 */

const egress = z.array(z.string()).default([]);
const selector = z
  .record(z.string(), z.string())
  .refine((r) => Object.keys(r).length > 0, 'selector must not be empty');

export const KubernetesJobRunnerConfigSchema = z.strictObject({
  namespace: z.string().default('openagentix-runs'),
  /** ServiceAccount of the Job; on EKS annotate it for IRSA (`eks.amazonaws.com/role-arn`). */
  serviceAccountName: z.string().default('openagentix-run-node'),
  /** Worker identity; the step ServiceAccount and namespace must differ from it (refused otherwise). */
  workerServiceAccount: z.string().default('openagentix-worker'),
  workerNamespace: z.string().optional(),
  registry: z.string().default('ghcr.io/open-agentix'),
  ttlSecondsAfterFinished: z.number().int().nonnegative().default(600),
  activeDeadlineSeconds: z.number().int().positive().default(3600),
  /**
   * Operator ceiling for step egress: a step's `runtime.egress` CIDRs must each lie inside one of
   * these (intersection, never union). Empty = steps get no extra egress. Prefixes >= /8 (v4) or
   * >= /32 (v6) only.
   */
  egress,
  /** Per-step ceiling (and default floor ratio): step limits are clamped into [32Mi/50m, this]. */
  resources: z
    .strictObject({ cpu: z.string().default('500m'), memory: z.string().default('512Mi') })
    .default({ cpu: '500m', memory: '512Mi' }),
  nodeSelector: z.record(z.string(), z.string()).default({}),
  imagePullSecrets: z.array(z.string()).default([]),
  /**
   * Mount the ServiceAccount API token into the step Pod. Off by default: a step never needs the
   * Kubernetes API. IRSA on EKS does not need it either (its projected web-identity token is
   * injected by the EKS pod identity webhook independently of this flag).
   */
  automountServiceAccountToken: z.boolean().default(false),
  /** Toolbox names (`toolbox-<name>` images) a step may use. Empty = NO toolbox image (fail closed). */
  toolboxAllowlist: z.array(z.string()).default([]),
  /** Non-toolbox images (exact repository path below `registry`, e.g. `openagentix-worker`). */
  runNodeImages: z.array(z.string()).default([]),
  /** Always-denied destinations (`except` blocks) in addition to the built-in link-local/IMDS/loopback: cluster, pod and service CIDRs. */
  denyCidrs: z.array(z.string()).default([]),
  /** Air-gapped mode (OAX_AIRGAPPED): a step may not declare any egress. */
  airgapped: z.boolean().default(false),
  /** UID/GID the step container runs as; must match the image's non-root user. */
  runAsUser: z.number().int().min(1).default(65532),
  /** Name of the static namespace-wide default-deny NetworkPolicy that must exist before a step starts. */
  defaultDenyPolicy: z.string().default('default-deny-all'),
  /** Allow DNS to kube-dns in `kube-system` (needed to resolve the control node). */
  dnsEgress: z.boolean().default(true),
  /** Where the control node lives; the only cluster-internal destination a step may reach. */
  controlPlane: z
    .strictObject({
      /** Non-empty when set (an empty selector would match every pod). */
      podSelector: selector.optional(),
      /** Non-empty when set; prefer `kubernetes.io/metadata.name: <ns>`. */
      namespaceSelector: selector.optional(),
      cidrs: z.array(z.string()).default([]),
      ports: z.array(z.number().int().min(1).max(65535)).default([443]),
    })
    .default({ cidrs: [], ports: [443] }),
});

export const AwsLambdaRunnerConfigSchema = z.strictObject({
  region: z.string(),
  /** One function per agent version: `<prefix>-<agent>-<version>`. */
  functionPrefix: z.string().default('openagentix'),
  roleArn: z.string(),
  subnetIds: z.array(z.string()).default([]),
  securityGroupIds: z.array(z.string()).default([]),
  timeoutSeconds: z.number().int().positive().max(900).default(900),
  memoryMb: z.number().int().positive().default(1024),
});

export const GithubActionsRunnerConfigSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workflow: z.string().default('openagentix-run.yml'),
  ref: z.string().default('main'),
  /** Secret reference of a token with `actions:write` on the target repository. */
  tokenSecret: z.string(),
  /** Results are posted back to this signed callback URL of the control node. */
  callbackBaseUrl: z.string().url(),
});

export const GitlabCiRunnerConfigSchema = z.strictObject({
  baseUrl: z.string().url().default('https://gitlab.com'),
  projectId: z.string(),
  ref: z.string().default('main'),
  /** Secret reference of a pipeline trigger token. */
  triggerTokenSecret: z.string(),
  callbackBaseUrl: z.string().url(),
});

export const RUNNER_CONFIG_SCHEMAS = {
  'kubernetes-job': KubernetesJobRunnerConfigSchema,
  'aws-lambda': AwsLambdaRunnerConfigSchema,
  'github-actions': GithubActionsRunnerConfigSchema,
  'gitlab-ci': GitlabCiRunnerConfigSchema,
} as const;

export type RemoteRunnerKind = keyof typeof RUNNER_CONFIG_SCHEMAS;

const MILESTONE: Record<StubRunnerKind, string> = {
  'aws-lambda': 'v0.3',
  'github-actions': 'v0.3',
  'gitlab-ci': 'v0.3',
};

/** Remote runners that are still stubs (`kubernetes-job` is implemented in kubernetes-job.ts). */
export type StubRunnerKind = Exclude<RemoteRunnerKind, 'kubernetes-job'>;

export class StubRunner<K extends StubRunnerKind> implements Runner {
  readonly config: z.infer<(typeof RUNNER_CONFIG_SCHEMAS)[K]>;

  constructor(
    readonly kind: K & RunnerKind,
    config: unknown = {},
  ) {
    this.config = RUNNER_CONFIG_SCHEMAS[kind].parse(config) as z.infer<
      (typeof RUNNER_CONFIG_SCHEMAS)[K]
    >;
  }

  async execute(_run: PreparedRun, _ctx: RunnerContext): Promise<RunResult> {
    throw new NotImplementedError(
      `Runner "${this.kind}"`,
      `It is planned for ${MILESTONE[this.kind]}; use "in-process" or "local" for now (see ROADMAP.md and docs/adr/0005-runners-and-external-harnesses.md).`,
    );
  }
}
