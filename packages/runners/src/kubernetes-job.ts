import {
  NotImplementedError,
  OaxError,
  type HarnessKind,
  type RunnerKind,
} from '@openagentix/core';
import type { z } from 'zod';
import {
  ALWAYS_DENIED_CIDRS,
  cidrContains,
  formatCidr,
  minPrefix,
  parseCidr,
  type Cidr,
} from './cidr.js';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
const MIN_CPU = 0.05;
const MIN_MEMORY_MB = 32;

export function isCidr(value: string): boolean {
  return parseCidr(value) !== undefined;
}

function bad(message: string): OaxError {
  return new OaxError('runner_invalid', message);
}

/** The node id must be a UUID (never slugified, so distinct nodes can never share a name). */
export function normalizeNodeId(nodeId: string): string {
  if (!UUID.test(nodeId)) throw bad('nodeId must be a UUID');
  return nodeId.toLowerCase();
}

/** Kubernetes object name for the Job, Secret and NetworkPolicy of a node. */
export function nodeObjectName(nodeId: string): string {
  return `oax-step-${normalizeNodeId(nodeId)}`;
}

function labelValue(name: string, v: string): string {
  if (!ID.test(v)) throw bad(`${name} "${v.slice(0, 40)}" is not a valid identifier`);
  return v;
}

/**
 * Checks the run node image: under the configured registry, pinned by digest, and allowlisted by
 * its exact repository path. `toolbox-<name>` images must be in `toolboxAllowlist` (an empty list
 * allows none); any other image must be listed verbatim in `runNodeImages`. Case-insensitive.
 */
export function validateImage(image: string, cfg: KubernetesJobRunnerConfig): void {
  const registry = cfg.registry.replace(/\/+$/, '').toLowerCase();
  const lower = image.toLowerCase();
  if (!lower.startsWith(`${registry}/`)) {
    throw bad(`image "${image}" is not under the configured registry "${registry}"`);
  }
  if (!IMAGE_DIGEST.test(lower) || lower.split('@').length !== 2) {
    throw bad(`image "${image}" must be pinned by digest (exactly one @sha256:...)`);
  }
  const repo = lower.slice(0, lower.indexOf('@'));
  const rel = repo.slice(registry.length + 1);
  if (/\s/.test(image) || rel.includes(':') || !/^[a-z0-9][a-z0-9._/-]*$/.test(rel)) {
    throw bad(`image "${image}" must be a plain repository path without a tag`);
  }
  if (/^toolbox-[a-z0-9][a-z0-9-]*$/.test(rel)) {
    const name = rel.slice('toolbox-'.length);
    const allowed = cfg.toolboxAllowlist.map((t) => t.toLowerCase().replace(/\+/g, '-'));
    if (!allowed.includes(name)) throw bad(`toolbox "${name}" is not in the toolbox allowlist`);
  } else if (!cfg.runNodeImages.map((i) => i.toLowerCase()).includes(rel)) {
    throw bad(`image "${rel}" is not an allowed run node image`);
  }
}

export interface EgressCidr {
  cidr: string;
  /** Always-denied ranges inside `cidr` (IMDS, link-local, loopback, cluster CIDRs). */
  except: string[];
}

export interface NetworkPolicyPlan {
  cidrs: EgressCidr[];
  /**
   * Host names cannot be expressed by a Kubernetes NetworkPolicy. They are NOT opened (fail
   * closed); they are handed to the node as `OAX_EGRESS_ALLOW` for an egress gateway/proxy.
   */
  hosts: string[];
}

function checkedCidr(raw: string, what: string): Cidr {
  const c = parseCidr(raw);
  if (!c) throw bad(`${what} "${raw}" is not a valid CIDR`);
  if (c.bits < minPrefix(c.version)) {
    throw bad(`${what} "${raw}" is too broad (minimum prefix /${minPrefix(c.version)})`);
  }
  return c;
}

/**
 * Effective step egress. The operator list (`cfg.egress`) is an UPPER BOUND: every CIDR a step
 * declares must lie inside one operator CIDR (the step can only narrow, never widen), must not be
 * broader than /8 (v4) or /32 (v6) and must not be inside an always-denied range; denied ranges
 * contained in an allowed CIDR are punched out with `except`. In air-gapped mode a step may not
 * declare any egress.
 */
export function planEgress(
  stepEgress: string[],
  cfg: KubernetesJobRunnerConfig,
): NetworkPolicyPlan {
  const entries = stepEgress.map((e) => e.trim()).filter(Boolean);
  if (entries.length > 0 && cfg.airgapped) {
    throw bad('air-gapped mode: steps must not declare egress');
  }
  const ceiling = cfg.egress.map((e) => checkedCidr(e, 'operator egress entry'));
  const denied = [...ALWAYS_DENIED_CIDRS, ...cfg.denyCidrs].map((d) => {
    const c = parseCidr(d);
    if (!c) throw bad(`deny CIDR "${d}" is not a valid CIDR`);
    return { ...c, text: formatCidr(c) };
  });
  const cidrs = new Map<string, EgressCidr>();
  const hosts = new Set<string>();
  for (const e of entries) {
    if (e.includes('/') || /^[0-9.]+$/.test(e) || e.includes(':')) {
      const c = checkedCidr(e, 'egress entry');
      if (!ceiling.some((o) => cidrContains(o, c))) {
        throw bad(`egress entry "${e}" is outside the operator egress allowlist`);
      }
      if (denied.some((d) => cidrContains(d, c))) {
        throw bad(`egress entry "${e}" is inside an always-denied range`);
      }
      const canonical = formatCidr(c);
      cidrs.set(canonical, {
        cidr: canonical,
        except: denied
          .filter((d) => d.version === c.version && cidrContains(c, d))
          .map((d) => d.text),
      });
    } else {
      if (!/^(\*\.)?[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(e)) {
        throw bad(`egress entry "${e}" is neither a CIDR nor a host name`);
      }
      hosts.add(e.toLowerCase());
    }
  }
  return {
    cidrs: [...cidrs.values()].sort((a, b) => a.cidr.localeCompare(b.cidr)),
    hosts: [...hosts].sort(),
  };
}

/** Parses a Kubernetes cpu quantity (`500m`, `2`) into cores. */
export function parseCpu(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) throw bad(`invalid cpu quantity "${q}"`);
  return m[2] ? Number(m[1]) / 1000 : Number(m[1]);
}

/** Parses a Kubernetes memory quantity (`512Mi`, `1Gi`, `256M`) into MiB. */
export function parseMemoryMb(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(q.trim());
  if (!m) throw bad(`invalid memory quantity "${q}"`);
  const mult: Record<string, number> = {
    '': 1 / (1024 * 1024),
    Ki: 1 / 1024,
    Mi: 1,
    Gi: 1024,
    K: 1000 / (1024 * 1024),
    M: 1e6 / (1024 * 1024),
    G: 1e9 / (1024 * 1024),
  };
  return Number(m[1]) * mult[m[2] ?? '']!;
}

/** Rejects operator ceilings that would round to 0 / below the floor (which would mean "no limit"). */
export function validateResourceCeiling(r: { cpu: string; memory: string }): void {
  if (parseCpu(r.cpu) < MIN_CPU) throw bad(`resources.cpu "${r.cpu}" is below the minimum of 50m`);
  if (Math.floor(parseMemoryMb(r.memory)) < MIN_MEMORY_MB) {
    throw bad(`resources.memory "${r.memory}" is below the minimum of 32Mi`);
  }
}

/** Step limits clamped into [floor, operator ceiling] (`resources`); never zero or unbounded. */
export function effectiveResources(
  limits: RunNodeSpec['limits'],
  cfg: KubernetesJobRunnerConfig,
): { cpu: string; memory: string } {
  if (
    ![limits.cpus, limits.memoryMb, limits.timeoutSeconds].every((n) => Number.isFinite(n) && n > 0)
  ) {
    throw bad('run node limits must be positive finite numbers');
  }
  const maxCpu = parseCpu(cfg.resources.cpu);
  const maxMem = Math.floor(parseMemoryMb(cfg.resources.memory));
  const cpu = Math.min(Math.max(limits.cpus, Math.min(MIN_CPU, maxCpu)), maxCpu);
  const mem = Math.min(
    Math.max(Math.ceil(limits.memoryMb), Math.min(MIN_MEMORY_MB, maxMem)),
    maxMem,
  );
  return { cpu: `${Math.max(1, Math.round(cpu * 1000))}m`, memory: `${mem}Mi` };
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
    [LABEL_NODE]: normalizeNodeId(spec.nodeId),
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
  const plan = planEgress(spec.egress, cfg);
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
    const pc = parseCidr(c);
    if (!pc || pc.bits === 0) throw bad(`invalid control plane CIDR "${c}"`);
    cpTo.push({ ipBlock: { cidr: c } });
  }
  if (cpTo.length > 0) {
    // An empty `ports` list would allow every port to the control plane peers (fail closed).
    if (cp.ports.length === 0) throw bad('controlPlane.ports must list at least one port');
    egress.push({ to: cpTo, ports: cp.ports.map((port) => ({ protocol: 'TCP', port })) });
  }
  for (const { cidr, except } of plan.cidrs) {
    egress.push({ to: [{ ipBlock: { cidr, ...(except.length > 0 ? { except } : {}) } }] });
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: nodeObjectName(spec.nodeId),
      namespace: cfg.namespace,
      labels: commonLabels(spec),
    },
    spec: {
      podSelector: { matchLabels: { [LABEL_NODE]: normalizeNodeId(spec.nodeId) } },
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
  const res = effectiveResources(l, cfg);
  if (!/^https:\/\/[^\s]+$/.test(spec.controlUrl)) throw bad('controlUrl must be an https URL');
  const name = nodeObjectName(spec.nodeId);
  const labels = commonLabels(spec);
  const plan = planEgress(spec.egress, cfg);
  const { cpu, memory } = res;
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
                { name: 'OAX_NODE_ID', value: normalizeNodeId(spec.nodeId) },
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
  /** How long stop() waits for the Pods to be gone before it gives up (default 60 s). */
  cleanupTimeoutMs?: number;
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
 * Secret with the run token only (the Secret is owner-referenced to the Job, the policy is not), then
 * unsuspends the Job.
 * Everything this call created (and nothing else) is deleted when the node stops.
 *
 * Prerequisites: a CNI that enforces NetworkPolicy and a namespace-wide default-deny policy
 * (docs/examples/kubernetes-job-runner-rbac.yaml) so that per-step policies are purely additive.
 *
 * INTEGRATION POINTS (W1-3a): the orchestrator's `dispatchStep` seam calls `startNode`; session
 * creation/revocation, the step-scoped run token and the `runnode.*` audit entries live there.
 */
export class KubernetesJobRunner implements IsolatingRunner {
  readonly kind: RunnerKind = 'kubernetes-job';
  readonly config: KubernetesJobRunnerConfig;
  private readonly client: KubeClient;
  private readonly pollMs: number;
  private readonly cleanupPolls: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(opts: KubernetesJobRunnerOptions) {
    this.config = KubernetesJobRunnerConfigSchema.parse(opts.config ?? {});
    if (this.config.serviceAccountName === this.config.workerServiceAccount) {
      throw bad('the step ServiceAccount must differ from the worker ServiceAccount');
    }
    if (this.config.workerNamespace && this.config.namespace === this.config.workerNamespace) {
      throw bad('the run namespace must differ from the worker namespace');
    }
    validateResourceCeiling(this.config.resources);
    // Misconfigured images are a start-up error, not a surprise at the first step (fail closed).
    for (const image of [this.config.image, ...Object.values(this.config.toolboxImages)]) {
      if (image !== undefined) validateImage(image, this.config);
    }
    this.client = opts.client;
    this.pollMs = opts.pollMs ?? 2000;
    this.cleanupPolls = Math.max(1, Math.ceil((opts.cleanupTimeoutMs ?? 60_000) / this.pollMs));
    this.sleep = opts.sleep ?? defaultSleep;
    this.warn = opts.warn ?? (() => undefined);
  }

  /** Limits the worker hands to ordinary steps: the operator ceilings (steps are clamped again). */
  defaultLimits(): { cpus: number; memoryMb: number; pids: number } {
    return {
      cpus: parseCpu(this.config.resources.cpu),
      memoryMb: Math.floor(parseMemoryMb(this.config.resources.memory)),
      pids: 256,
    };
  }

  /** Image for a step: its toolbox image, else the default. Unknown toolboxes/harnesses fail closed. */
  imageFor(toolbox: string | undefined, harness?: HarnessKind): string {
    if (harness) {
      throw new OaxError(
        'harness_image_unknown',
        `harness "${harness}" steps are not supported by the kubernetes-job runner yet`,
      );
    }
    if (!toolbox) {
      if (!this.config.image) {
        throw new OaxError(
          'run_node_image_unknown',
          'no run node image is configured (OAX_K8S_IMAGE)',
        );
      }
      return this.config.image;
    }
    const image = this.config.toolboxImages[toolbox];
    if (!image) {
      throw new OaxError(
        'toolbox_image_unknown',
        `no image is configured for toolbox "${toolbox}" (OAX_K8S_TOOLBOX_IMAGES)`,
      );
    }
    return image;
  }

  async execute(_run: PreparedRun, _ctx: RunnerContext): Promise<RunResult> {
    throw new NotImplementedError(
      'Runner "kubernetes-job" whole-run execution',
      'It runs single steps as run nodes through startNode(); the orchestrator dispatches isolated steps (ADR 0008, section 3).',
    );
  }

  /**
   * Per-step policies are only additive on top of the namespace default-deny policy; if it is
   * missing (or not a real deny-all) nothing is started (fail closed).
   */
  private async requireDefaultDeny(): Promise<void> {
    const name = this.config.defaultDenyPolicy;
    const p = (await this.client.getNetworkPolicy(this.config.namespace, name)) as {
      spec?: {
        podSelector?: { matchLabels?: unknown; matchExpressions?: unknown };
        policyTypes?: string[];
        ingress?: unknown[];
        egress?: unknown[];
      };
    } | null;
    const sp = p?.spec;
    const ok =
      !!sp &&
      !sp.podSelector?.matchLabels &&
      !sp.podSelector?.matchExpressions &&
      (sp.policyTypes ?? []).includes('Ingress') &&
      (sp.policyTypes ?? []).includes('Egress') &&
      !(sp.ingress && sp.ingress.length > 0) &&
      !(sp.egress && sp.egress.length > 0);
    if (!ok) {
      throw bad(
        `namespace "${this.config.namespace}" has no default-deny NetworkPolicy "${name}" (ingress+egress, empty podSelector); refusing to start a step`,
      );
    }
  }

  async startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal } = {}): Promise<RunNodeHandle> {
    if (ctx.signal?.aborted) throw bad('start aborted');
    const ns = this.config.namespace;
    // Build and validate everything before the first API call.
    const job = buildJob(spec, this.config);
    const policy = buildNetworkPolicy(spec, this.config);
    const secret = buildSecret(spec, ns);
    const plan = planEgress(spec.egress, this.config);
    if (plan.hosts.length > 0) {
      this.warn(
        `egress host names are not enforced by a NetworkPolicy (${plan.hosts.join(', ')}); use an egress gateway`,
      );
    }
    const name = job.metadata.name;
    const handle = new JobHandle(
      this.client,
      ns,
      name,
      normalizeNodeId(spec.nodeId),
      this.pollMs,
      this.cleanupPolls,
      this.sleep,
    );
    await this.requireDefaultDeny();
    // A failed createJob (e.g. 409 for an existing name) created nothing: nothing is deleted.
    const { uid } = await this.client.createJob(ns, job);
    handle.created.job = uid;
    try {
      const owner: OwnerReference = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        name,
        uid,
        controller: true,
        // No blockOwnerDeletion: it would need `jobs/finalizers` RBAC under
        // OwnerReferencesPermissionEnforcement.
      };
      // Only the Secret is owned by the Job. The NetworkPolicy deliberately has NO owner reference:
      // with Foreground deletion the GC would remove an owned policy in parallel with the Pods'
      // termination. It is deleted explicitly, after the Pods are confirmed gone (labels let a
      // future sweeper find leftovers).
      secret.metadata.ownerReferences = [owner];
      handle.created.policy = (await this.client.createNetworkPolicy(ns, policy)).uid;
      handle.created.secret = (await this.client.createSecret(ns, secret)).uid;
      await this.client.patchJob(ns, name, { spec: { suspend: false } });
    } catch (err) {
      // Never leave a half-created node behind (only what this call created is removed).
      await handle.stop('cancelled').catch(() => undefined);
      throw err;
    }
    return handle;
  }
}

class JobHandle implements RunNodeHandle {
  /** uids of exactly the objects this invocation created. */
  readonly created: { job?: string; secret?: string; policy?: string } = {};
  private stopped: Promise<void> | undefined;

  constructor(
    private readonly client: KubeClient,
    private readonly ns: string,
    private readonly name: string,
    readonly nodeId: string,
    private readonly pollMs: number,
    private readonly cleanupPolls: number,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {}

  async wait(signal?: AbortSignal): Promise<RunNodeExit> {
    for (;;) {
      if (signal?.aborted) return { exitCode: null, reason: 'cancelled' };
      const st = await this.client.getJob(this.ns, this.name);
      // A different uid means the Job was replaced by someone else: not our node any more.
      if (!st || st.uid !== this.created.job) return { exitCode: null, reason: 'job_missing' };
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

  private async podsGone(): Promise<boolean> {
    for (let i = 0; i < this.cleanupPolls; i++) {
      const st = await this.client.getJob(this.ns, this.name);
      if (!st || st.uid !== this.created.job) return true; // Foreground delete finished
      await this.sleep(this.pollMs);
    }
    return false;
  }

  /**
   * Order matters: the Job goes first with Foreground propagation (its Pods are gone before it
   * disappears), the NetworkPolicy last and only once the Pods are confirmed gone. The policy has
   * no owner reference, so the garbage collector never removes it in parallel with the Pods'
   * termination. If the Pods do not vanish in time the policy stays, the error is reported and a
   * retry of stop() (or a sweeper, via the labels) removes it; the namespace default-deny policy
   * is the fallback for everything in between.
   */
  private async cleanup(): Promise<void> {
    const errors: string[] = [];
    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
    let jobDeleted = this.created.job === undefined;
    if (this.created.job !== undefined) {
      try {
        await this.client.deleteJob(this.ns, this.name, this.created.job);
        jobDeleted = true;
      } catch (e) {
        errors.push(msg(e));
      }
    }
    if (this.created.secret !== undefined) {
      try {
        await this.client.deleteSecret(this.ns, this.name, this.created.secret);
      } catch (e) {
        errors.push(msg(e));
      }
    }
    if (this.created.policy !== undefined) {
      if (jobDeleted && (this.created.job === undefined || (await this.podsGone()))) {
        try {
          await this.client.deleteNetworkPolicy(this.ns, this.name, this.created.policy);
        } catch (e) {
          errors.push(msg(e));
        }
      } else {
        errors.push(
          'NetworkPolicy kept: the Pods are not confirmed gone (retry stop() or sweep by label)',
        );
      }
    }
    if (errors.length > 0) {
      throw new OaxError(
        'runner_cleanup_failed',
        `cleanup of run node ${this.nodeId} failed: ${errors.join('; ')}`,
      );
    }
  }
}
