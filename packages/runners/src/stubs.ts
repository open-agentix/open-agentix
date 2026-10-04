import { NotImplementedError, type RunnerKind } from '@openagentix/core';
import { z } from 'zod';
import type { PreparedRun, RunResult, Runner, RunnerContext } from './types.js';

/**
 * Typed, documented stubs for remote runners. Their configuration schemas are final enough to be
 * used by the Helm chart and UI; execution lands in v0.2 (container, Kubernetes Job) and v0.3
 * (AWS Lambda, GitHub Actions, GitLab CI). See docs/adr/0005-runners-and-external-harnesses.md.
 */

const egress = z.array(z.string()).default([]);

export const KubernetesJobRunnerConfigSchema = z.strictObject({
  namespace: z.string().default('openagentix-runs'),
  /** ServiceAccount of the Job; on EKS annotate it for IRSA (`eks.amazonaws.com/role-arn`). */
  serviceAccountName: z.string().default('openagentix-worker'),
  registry: z.string().default('ghcr.io/open-agentix'),
  ttlSecondsAfterFinished: z.number().int().nonnegative().default(600),
  activeDeadlineSeconds: z.number().int().positive().default(3600),
  /** NetworkPolicy egress allowlist (CIDRs or DNS names via an egress gateway). */
  egress,
  resources: z
    .strictObject({ cpu: z.string().default('500m'), memory: z.string().default('512Mi') })
    .default({ cpu: '500m', memory: '512Mi' }),
  nodeSelector: z.record(z.string(), z.string()).default({}),
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

const MILESTONE: Record<RemoteRunnerKind, string> = {
  'kubernetes-job': 'v0.2',
  'aws-lambda': 'v0.3',
  'github-actions': 'v0.3',
  'gitlab-ci': 'v0.3',
};

export class StubRunner<K extends RemoteRunnerKind> implements Runner {
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
