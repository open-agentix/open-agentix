import { NotImplementedError, OaxError, type RunnerKind } from '@openagentix/core';
import type { z } from 'zod';
import type {
  IsolatingRunner,
  RunNodeExit,
  RunNodeHandle,
  RunNodeSpec,
  RunNodeStopReason,
} from './isolating.js';
import type { KubeClient, KubeObject, OwnerReference } from './kube-client.js';
import { KubernetesJobRunnerConfigSchema } from './stubs.js';
import type { PreparedRun, RunResult, RunnerContext } from './types.js';

export type KubernetesJobRunnerConfig = z.infer<typeof KubernetesJobRunnerConfigSchema>;
export type KubernetesJobRunnerConfigInput = z.input<typeof KubernetesJobRunnerConfigSchema>;

/** Path of the run token inside the step container (ADR 0008 3.3: a file, never env). */
export const RUN_TOKEN_DIR = '/run/oax';
export const RUN_TOKEN_FILE = `${RUN_TOKEN_DIR}/token`;
export const LABEL_APP = 'app.kubernetes.io/name';
export const APP_NAME = 'openagentix-run-node';
export const LABEL_RUN = 'openagentix.io/run-id';
export const LABEL_NODE = 'openagentix.io/node-id';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
const CIDR4 = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const CIDR6 = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*\/(\d{1,2}|1[01]\d|12[0-8])$/;

export function isCidr(value: string): boolean {
  if (CIDR4.test(value)) {
    return value
      .split('/')[0]!
      .split('.')
      .every((o) => Number(o) <= 255);
  }
  return CIDR6.test(value);
}

function bad(message: string): OaxError {
  return new OaxError('runner_invalid', message);
}

/** Kubernetes object name for the Job, Secret and NetworkPolicy of a node. */
export function nodeObjectName(nodeId: string): string {
  const slug = nodeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!slug) throw bad('nodeId does not yield a valid Kubernetes name');
  return `oax-step-${slug}`;
}

function labelValue(name: string, v: string): string {
  if (!ID.test(v)) throw bad(`${name} "${v.slice(0, 40)}" is not a valid identifier`);
  return v;
}

/**
 * Checks the run node image: under the configured registry, pinned by digest, and allowlisted.
 * Toolbox images are `toolbox-<name>` and are checked against `toolboxAllowlist` (empty = any);
 * any other image must be listed in `runNodeImages`.
 */
export function validateImage(image: string, cfg: KubernetesJobRunnerConfig): void {
  const registry = cfg.registry.replace(/\/+$/, '');
  if (!image.startsWith(`${registry}/`)) {
    throw bad(`image "${image}" is not under the configured registry "${registry}"`);
  }
  if (!IMAGE_DIGEST.test(image))
    throw bad(`image "${image}" must be pinned by digest (@sha256:...)`);
  const repo = image.slice(0, image.indexOf('@'));
  if (/\s/.test(image) || repo.includes(':', registry.length)) {
    throw bad(`image "${image}" must not carry a tag`);
  }
  const base = repo
    .slice(registry.length + 1)
    .split('/')
    .pop()!;
  if (base.startsWith('toolbox-')) {
    const name = base.slice('toolbox-'.length);
    const allowed = cfg.toolboxAllowlist.map((t) => t.replace(/\+/g, '-'));
    if (allowed.length > 0 && !allowed.includes(name)) {
      throw bad(`toolbox "${name}" is not in the toolbox allowlist`);
    }
  } else if (!cfg.runNodeImages.includes(base)) {
    throw bad(`image "${base}" is not an allowed run node image`);
  }
}

export interface NetworkPolicyPlan {
  /** CIDRs opened for the step (cluster-wide `egress` plus the step's CIDR entries). */
  cidrs: string[];
  /**
   * Host names cannot be expressed by a Kubernetes NetworkPolicy. They are NOT opened (fail
   * closed); they are handed to the node as `OAX_EGRESS_ALLOW` for an egress gateway/proxy.
   */
  hosts: string[];
}

export function planEgress(stepEgress: string[], clusterEgress: string[]): NetworkPolicyPlan {
  const cidrs = new Set<string>();
  const hosts = new Set<string>();
  for (const raw of [...clusterEgress, ...stepEgress]) {
    const e = raw.trim();
    if (!e) continue;
    if (e.includes('/') || /^[0-9.]+$/.test(e) || e.includes(':')) {
      if (!isCidr(e)) throw bad(`egress entry "${e}" is not a valid CIDR`);
      const mask = Number(e.split('/')[1]);
      if (mask === 0) throw bad(`egress entry "${e}" would open all destinations`);
      cidrs.add(e);
    } else {
      if (!/^(\*\.)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(e)) {
        throw bad(`egress entry "${e}" is neither a CIDR nor a host name`);
      }
      hosts.add(e.toLowerCase());
    }
  }
  return { cidrs: [...cidrs].sort(), hosts: [...hosts].sort() };
}

function selectorPeer(
  podSelector?: Record<string, string>,
  namespaceSelector?: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!podSelector && !namespaceSelector) return undefined;
  return {
    ...(namespaceSelector ? { namespaceSelector: { matchLabels: namespaceSelector } } : {}),
    ...(podSelector ? { podSelector: { matchLabels: podSelector } } : {}),
  };
}

function commonLabels(spec: RunNodeSpec): Record<string, string> {
  return {
    [LABEL_APP]: APP_NAME,
    'app.kubernetes.io/managed-by': 'openagentix',
    [LABEL_RUN]: labelValue('runId', spec.runId),
    [LABEL_NODE]: labelValue('nodeId', spec.nodeId),
  };
}

export function buildSecret(spec: RunNodeSpec, namespace: string): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: nodeObjectName(spec.nodeId), namespace, labels: commonLabels(spec) },
    type: 'Opaque',
    immutable: true,
    // Only the step-scoped run token. Step credentials are pulled by the node (credential broker).
    data: { token: Buffer.from(spec.runToken, 'utf8').toString('base64') },
  };
}

export function buildNetworkPolicy(spec: RunNodeSpec, cfg: KubernetesJobRunnerConfig): KubeObject {
  const plan = planEgress(spec.egress, cfg.egress);
  const egress: Record<string, unknown>[] = [];
  if (cfg.dnsEgress) {
    egress.push({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    });
  }
  const cp = cfg.controlPlane;
  const cpTo: Record<string, unknown>[] = [];
  const peer = selectorPeer(cp.podSelector, cp.namespaceSelector);
  if (peer) cpTo.push(peer);
  for (const c of cp.cidrs) {
    if (!isCidr(c) || Number(c.split('/')[1]) === 0) throw bad(`invalid control plane CIDR "${c}"`);
    cpTo.push({ ipBlock: { cidr: c } });
  }
  if (cpTo.length > 0) {
    egress.push({ to: cpTo, ports: cp.ports.map((port) => ({ protocol: 'TCP', port })) });
  }
  for (const cidr of plan.cidrs) egress.push({ to: [{ ipBlock: { cidr } }] });
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: nodeObjectName(spec.nodeId),
      namespace: cfg.namespace,
      labels: commonLabels(spec),
    },
    spec: {
      podSelector: { matchLabels: { [LABEL_NODE]: spec.nodeId } },
      policyTypes: ['Ingress', 'Egress'],
      // No ingress rule at all: nothing can connect to a step Pod.
      ingress: [],
      egress,
    },
  };
}

export function buildJob(spec: RunNodeSpec, cfg: KubernetesJobRunnerConfig): KubeObject {
  validateImage(spec.image, cfg);
  if (spec.steps.length === 0) throw bad('a run node needs at least one step');
  const l = spec.limits;
  if (!(l.cpus > 0) || !(l.memoryMb > 0) || !(l.timeoutSeconds > 0)) {
    throw bad('run node limits must be positive');
  }
  if (!/^https?:\/\/[^\s]+$/.test(spec.controlUrl)) throw bad('controlUrl must be an http(s) URL');
  const name = nodeObjectName(spec.nodeId);
  const labels = commonLabels(spec);
  const plan = planEgress(spec.egress, cfg.egress);
  const cpu = String(Number(spec.limits.cpus.toFixed(3)));
  const memory = `${Math.ceil(l.memoryMb)}Mi`;
  const deadline = Math.min(cfg.activeDeadlineSeconds, Math.ceil(l.timeoutSeconds));
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: cfg.namespace, labels },
    spec: {
      // Created suspended: the NetworkPolicy and Secret (both owned by this Job) must exist
      // before any Pod can start, so there is never an unprotected window.
      suspend: true,
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: deadline,
      ttlSecondsAfterFinished: cfg.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: cfg.serviceAccountName,
          automountServiceAccountToken: cfg.automountServiceAccountToken,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          terminationGracePeriodSeconds: 10,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: cfg.runAsUser,
            runAsGroup: cfg.runAsUser,
            fsGroup: cfg.runAsUser,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          ...(cfg.imagePullSecrets.length > 0
            ? { imagePullSecrets: cfg.imagePullSecrets.map((n) => ({ name: n })) }
            : {}),
          ...(Object.keys(cfg.nodeSelector).length > 0 ? { nodeSelector: cfg.nodeSelector } : {}),
          containers: [
            {
              name: 'run-node',
              image: spec.image,
              imagePullPolicy: 'IfNotPresent',
              // INTEGRATION POINT (W1-3a): `oax run-node` is the run node entrypoint of the worker/toolbox image.
              command: ['oax', 'run-node'],
              // Non-secret settings only; the run token is a file, credentials are pulled by the node.
              env: [
                { name: 'OAX_CONTROL_URL', value: spec.controlUrl },
                { name: 'OAX_RUN_ID', value: spec.runId },
                { name: 'OAX_NODE_ID', value: spec.nodeId },
                { name: 'OAX_STEP_IDS', value: spec.steps.join(',') },
                { name: 'OAX_RUN_TOKEN_FILE', value: RUN_TOKEN_FILE },
                { name: 'OAX_EGRESS_ALLOW', value: plan.hosts.join(',') },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                privileged: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: {
                requests: { cpu, memory },
                limits: { cpu, memory, 'ephemeral-storage': '1Gi' },
              },
              volumeMounts: [
                { name: 'run-token', mountPath: RUN_TOKEN_DIR, readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            {
              name: 'run-token',
              secret: { secretName: name, defaultMode: 0o400, optional: false },
            },
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
          ],
        },
      },
    },
  };
}

export interface KubernetesJobRunnerOptions {
  client: KubeClient;
  config?: KubernetesJobRunnerConfigInput;
  /** Job status poll interval; the API server is never watched, only polled. */
  pollMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Receives non-fatal findings, e.g. egress host names that a NetworkPolicy cannot enforce. */
  warn?: (message: string) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Runs one run node per step as a Kubernetes Job (ADR 0008 3.5). Per step it creates, in the run
 * namespace only: a suspended Job, a NetworkPolicy (deny all ingress, egress allowlist) and a
 * Secret with the run token only (both owner-referenced to the Job), then unsuspends the Job.
 * Everything is deleted when the node stops.
 *
 * INTEGRATION POINTS (W1-3a): the orchestrator's `dispatchStep` seam calls `startNode`; session
 * creation/revocation, the step-scoped run token and the `runnode.*` audit entries live there.
 */
export class KubernetesJobRunner implements IsolatingRunner {
  readonly kind: RunnerKind = 'kubernetes-job';
  readonly config: KubernetesJobRunnerConfig;
  private readonly client: KubeClient;
  private readonly pollMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(opts: KubernetesJobRunnerOptions) {
    this.config = KubernetesJobRunnerConfigSchema.parse(opts.config ?? {});
    this.client = opts.client;
    this.pollMs = opts.pollMs ?? 2000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.warn = opts.warn ?? (() => undefined);
  }

  async execute(_run: PreparedRun, _ctx: RunnerContext): Promise<RunResult> {
    throw new NotImplementedError(
      'Runner "kubernetes-job" whole-run execution',
      'It runs single steps as run nodes through startNode(); the orchestrator dispatches isolated steps (ADR 0008, section 3).',
    );
  }

  async startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal } = {}): Promise<RunNodeHandle> {
    if (ctx.signal?.aborted) throw bad('start aborted');
    const ns = this.config.namespace;
    // Build and validate everything before the first API call.
    const job = buildJob(spec, this.config);
    const policy = buildNetworkPolicy(spec, this.config);
    const secret = buildSecret(spec, ns);
    const plan = planEgress(spec.egress, this.config.egress);
    if (plan.hosts.length > 0) {
      this.warn(
        `egress host names are not enforced by a NetworkPolicy (${plan.hosts.join(', ')}); use an egress gateway`,
      );
    }
    const name = job.metadata.name;
    const handle = new JobHandle(this.client, ns, name, spec.nodeId, this.pollMs, this.sleep);
    try {
      const { uid } = await this.client.createJob(ns, job);
      const owner: OwnerReference = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        name,
        uid,
        controller: true,
        blockOwnerDeletion: true,
      };
      policy.metadata.ownerReferences = [owner];
      secret.metadata.ownerReferences = [owner];
      await this.client.createNetworkPolicy(ns, policy);
      await this.client.createSecret(ns, secret);
      await this.client.patchJob(ns, name, { spec: { suspend: false } });
    } catch (err) {
      // Never leave a half-created node behind.
      await handle.stop('cancelled').catch(() => undefined);
      throw err;
    }
    return handle;
  }
}

class JobHandle implements RunNodeHandle {
  private stopped: Promise<void> | undefined;

  constructor(
    private readonly client: KubeClient,
    private readonly ns: string,
    private readonly name: string,
    readonly nodeId: string,
    private readonly pollMs: number,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {}

  async wait(signal?: AbortSignal): Promise<RunNodeExit> {
    for (;;) {
      if (signal?.aborted) return { exitCode: null, reason: 'cancelled' };
      const st = await this.client.getJob(this.ns, this.name);
      if (!st) return { exitCode: null, reason: 'job_missing' };
      if (st.condition?.type === 'Complete' || (st.succeeded > 0 && !st.condition)) {
        return { exitCode: 0 };
      }
      if (st.condition?.type === 'Failed' || st.failed > 0) {
        const reason = st.condition?.reason === 'DeadlineExceeded' ? 'timeout' : 'failed';
        // The exit code is not read (no pod RBAC); a non-zero code is reported as null + reason.
        return { exitCode: null, reason };
      }
      await this.sleep(this.pollMs, signal);
    }
  }

  stop(_reason: RunNodeStopReason): Promise<void> {
    this.stopped ??= this.cleanup().catch((err: unknown) => {
      this.stopped = undefined; // allow a retry
      throw err;
    });
    return this.stopped;
  }

  private async cleanup(): Promise<void> {
    // Delete the Job first (stops the Pod), then the explicit objects; try all, report once.
    const errors: unknown[] = [];
    for (const op of [
      () => this.client.deleteJob(this.ns, this.name),
      () => this.client.deleteSecret(this.ns, this.name),
      () => this.client.deleteNetworkPolicy(this.ns, this.name),
    ]) {
      try {
        await op();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new OaxError(
        'runner_cleanup_failed',
        `cleanup of run node ${this.nodeId} failed: ${errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join('; ')}`,
      );
    }
  }
}
