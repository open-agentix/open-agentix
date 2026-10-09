/* eslint-disable @typescript-eslint/no-explicit-any -- manifests are inspected structurally in golden tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  InClusterKubeClient,
  KubernetesJobRunner,
  REQUIRED_RBAC,
  buildJob,
  buildNetworkPolicy,
  buildSecret,
  isCidr,
  nodeObjectName,
  effectiveResources,
  formatCidr,
  parseCidr,
  validateResourceCeiling,
  parseCpu,
  parseMemoryMb,
  planEgress,
  validateImage,
  type JobStatus,
  type KubeClient,
  type KubeObject,
  type KubernetesJobRunnerConfig,
  type RunNodeSpec,
} from '../src/index.js';
import { KubernetesJobRunnerConfigSchema } from '../src/stubs.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NODE = '3b0f6c2e-7d1a-4c53-9a39-0f4b3c1d2e55';
const OPEN = { toolboxAllowlist: ['git+node', 'trivy'], egress: ['10.0.0.0/8'] };
const RUN = '8f14e45f-ceea-467a-9575-1d5a1c3e9f10';
const TOKEN = 'oaxrt.SECRET-TOKEN-VALUE';

function spec(over: Partial<RunNodeSpec> = {}): RunNodeSpec {
  return {
    runId: RUN,
    nodeId: NODE,
    steps: ['action'],
    image: `ghcr.io/open-agentix/toolbox-git-node@${DIGEST}`,
    controlUrl: 'https://oax.example.org',
    runToken: TOKEN,
    limits: { cpus: 0.5, memoryMb: 256, timeoutSeconds: 120, pids: 128 },
    egress: ['10.1.0.0/16', 'api.example.org'],
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}): KubernetesJobRunnerConfig {
  return KubernetesJobRunnerConfigSchema.parse({
    namespace: 'runs',
    toolboxAllowlist: ['git+node', 'trivy'],
    egress: ['10.0.0.0/8', '192.0.2.0/24'],
    controlPlane: {
      namespaceSelector: { team: 'oax' },
      podSelector: { app: 'api' },
      ports: [8080],
    },
    ...over,
  });
}

class FakeKube implements KubeClient {
  calls: string[] = [];
  jobs = new Map<string, KubeObject>();
  secrets = new Map<string, KubeObject>();
  policies = new Map<string, KubeObject>();
  patches: Record<string, unknown>[] = [];
  deleteUids: Record<string, string | undefined> = {};
  statuses: (JobStatus | null)[] = [];
  failOn = new Set<string>();
  /** Job status after deleteJob: how many getJob calls still see the terminating Job. */
  lingerPolls = 0;
  deleted = false;
  defaultDeny: KubeObject | null = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'default-deny-all' },
    spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
  } as KubeObject;

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failOn.has(op)) throw new Error(`boom ${op}`);
  }
  async createJob(ns: string, job: KubeObject) {
    this.maybeFail('createJob');
    expect(ns).toBe(job.metadata.namespace);
    this.jobs.set(job.metadata.name, job);
    return { uid: 'job-uid-1' };
  }
  async patchJob(_ns: string, _name: string, patch: Record<string, unknown>) {
    this.maybeFail('patchJob');
    this.patches.push(patch);
  }
  async getJob(): Promise<JobStatus | null> {
    this.calls.push('getJob');
    if (this.deleted) {
      if (this.lingerPolls > 0) {
        this.lingerPolls--;
        return st({ active: 0 });
      }
      return null;
    }
    return this.statuses.length > 1 ? (this.statuses.shift() ?? null) : (this.statuses[0] ?? null);
  }
  async deleteJob(_ns: string, name: string, uid?: string) {
    this.maybeFail('deleteJob');
    this.deleteUids.job = uid;
    this.jobs.delete(name);
    this.deleted = true;
  }
  async createSecret(_ns: string, s: KubeObject) {
    this.maybeFail('createSecret');
    this.secrets.set(s.metadata.name, s);
    return { uid: 'secret-uid-1' };
  }
  async deleteSecret(_ns: string, name: string, uid?: string) {
    this.maybeFail('deleteSecret');
    this.deleteUids.secret = uid;
    this.secrets.delete(name);
  }
  async createNetworkPolicy(_ns: string, p: KubeObject) {
    this.maybeFail('createNetworkPolicy');
    this.policies.set(p.metadata.name, p);
    return { uid: 'policy-uid-1' };
  }
  async getNetworkPolicy(_ns: string, name: string): Promise<KubeObject | null> {
    this.maybeFail('getNetworkPolicy');
    expect(name).toBe('default-deny-all');
    return this.defaultDeny;
  }
  async deleteNetworkPolicy(_ns: string, name: string, uid?: string) {
    this.maybeFail('deleteNetworkPolicy');
    this.deleteUids.policy = uid;
    this.policies.delete(name);
  }
}

const st = (over: Partial<JobStatus> = {}): JobStatus => ({
  uid: 'job-uid-1',
  succeeded: 0,
  failed: 0,
  active: 1,
  ...over,
});

describe('manifests', () => {
  const job = buildJob(spec(), cfg()) as KubeObject & {
    spec: Record<string, any>;
  };
  const pod = job.spec.template.spec;
  const c = pod.containers[0];

  it('produces a hardened, bounded Job (golden shape)', () => {
    expect(job.metadata.name).toBe(`oax-step-${NODE}`);
    expect(job.spec).toMatchObject({
      suspend: true,
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 600,
    });
    expect(pod).toMatchObject({
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    expect(c.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(c.resources.limits).toEqual({
      cpu: '500m',
      memory: '256Mi',
      'ephemeral-storage': '1Gi',
    });
    expect(c.resources.requests).toEqual({ cpu: '500m', memory: '256Mi' });
    expect(c.command).toEqual(['oax', 'run-node']);
    expect(pod.volumes).toEqual([
      {
        name: 'run-token',
        secret: { secretName: job.metadata.name, defaultMode: 0o400, optional: false },
      },
      { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
    ]);
  });

  it('puts no secret value into env, args or anywhere in the Job manifest', () => {
    expect(c.env.every((e: Record<string, unknown>) => !('valueFrom' in e))).toBe(true);
    expect(JSON.stringify(job)).not.toContain(TOKEN);
    expect(JSON.stringify(job)).not.toContain(Buffer.from(TOKEN).toString('base64'));
    expect(c.env.find((e: { name: string }) => e.name === 'OAX_RUN_TOKEN_FILE').value).toBe(
      '/run/oax/token',
    );
    expect(c.env.find((e: { name: string }) => e.name === 'OAX_EGRESS_ALLOW').value).toBe(
      'api.example.org',
    );
  });

  it('caps the deadline by the configured maximum and applies pull secrets/node selector', () => {
    const j = buildJob(
      spec({ limits: { cpus: 1, memoryMb: 128, timeoutSeconds: 99999, pids: 1 } }),
      cfg({ activeDeadlineSeconds: 300, imagePullSecrets: ['ghcr'], nodeSelector: { pool: 'a' } }),
    ) as any;
    expect(j.spec.activeDeadlineSeconds).toBe(300);
    expect(j.spec.template.spec.imagePullSecrets).toEqual([{ name: 'ghcr' }]);
    expect(j.spec.template.spec.nodeSelector).toEqual({ pool: 'a' });
  });

  it('can enable the service account token explicitly', () => {
    const j = buildJob(spec(), cfg({ automountServiceAccountToken: true })) as any;
    expect(j.spec.template.spec.automountServiceAccountToken).toBe(true);
  });

  it('refuses bad inputs before touching the cluster', () => {
    expect(() => buildJob(spec({ steps: [] }), cfg())).toThrow(/at least one step/);
    expect(() =>
      buildJob(spec({ limits: { cpus: 0, memoryMb: 1, timeoutSeconds: 1, pids: 1 } }), cfg()),
    ).toThrow(/limits/);
    expect(() => buildJob(spec({ controlUrl: 'ftp://x' }), cfg())).toThrow(/controlUrl/);
    expect(() => buildJob(spec({ controlUrl: 'http://oax.example.org' }), cfg())).toThrow(/https/);
    expect(() => buildJob(spec({ runId: 'bad id!' }), cfg())).toThrow(/runId/);
    expect(() => buildJob(spec({ nodeId: '!!!' }), cfg())).toThrow(/UUID/);
    expect(() => buildJob(spec({ nodeId: 'ABC_def' }), cfg())).toThrow(/UUID/);
  });

  it('builds a Secret with the run token only', () => {
    const s = buildSecret(spec(), 'runs') as any;
    expect(Object.keys(s.data)).toEqual(['token']);
    expect(Buffer.from(s.data.token, 'base64').toString()).toBe(TOKEN);
    expect(s.immutable).toBe(true);
  });

  it('builds a deny-by-default NetworkPolicy with an explicit allowlist', () => {
    const p = buildNetworkPolicy(spec({ egress: ['10.1.0.0/16', '192.0.2.0/25'] }), cfg()) as any;
    expect(p.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(p.spec.ingress).toEqual([]);
    expect(p.spec.podSelector.matchLabels['openagentix.io/node-id']).toBe(NODE);
    const egress = p.spec.egress;
    expect(egress).toHaveLength(4);
    expect(egress[0].ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
    expect(egress[1]).toEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { team: 'oax' } },
          podSelector: { matchLabels: { app: 'api' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 8080 }],
    });
    expect(egress.slice(2).map((e: any) => e.to[0].ipBlock.cidr)).toEqual([
      '10.1.0.0/16',
      '192.0.2.0/25',
    ]);
  });

  it('opens nothing but control plane and DNS when no egress is declared', () => {
    const p = buildNetworkPolicy(spec({ egress: [] }), cfg({ dnsEgress: false })) as any;
    expect(p.spec.egress).toHaveLength(1);
    const none = buildNetworkPolicy(
      spec({ egress: [] }),
      cfg({ dnsEgress: false, controlPlane: {} }),
    ) as any;
    expect(none.spec.egress).toEqual([]); // fully isolated
    const cidr = buildNetworkPolicy(
      spec({ egress: [] }),
      cfg({ dnsEgress: false, controlPlane: { cidrs: ['10.9.0.0/24'] } }),
    ) as any;
    expect(cidr.spec.egress[0].to).toEqual([{ ipBlock: { cidr: '10.9.0.0/24' } }]);
    expect(() =>
      buildNetworkPolicy(spec(), cfg({ controlPlane: { cidrs: ['0.0.0.0/0'] } })),
    ).toThrow(/control plane CIDR/);
  });
});

describe('egress planning (operator list is an upper bound)', () => {
  it('classifies CIDRs and hosts and only narrows the operator ceiling', () => {
    expect(planEgress(['b.example.org', '10.2.0.0/16', ' ', '*.x.io'], cfg())).toEqual({
      cidrs: [{ cidr: '10.2.0.0/16', except: [] }],
      hosts: ['*.x.io', 'b.example.org'],
    });
    // nothing declared = nothing opened, even if the operator list is wide
    expect(planEgress([], cfg())).toEqual({ cidrs: [], hosts: [] });
    expect(() => planEgress(['10.0.0.256/8'], cfg())).toThrow(/valid CIDR/);
    expect(() => planEgress(['10.0.0.1'], cfg())).toThrow(/valid CIDR/);
    expect(() => planEgress(['bad host'], cfg())).toThrow(/neither/);
    expect(isCidr('1.2.3.4/33')).toBe(false);
    expect(isCidr('1.2.3/24')).toBe(false);
  });

  it('rejects CIDRs outside the operator ceiling (superset, other range)', () => {
    expect(() => planEgress(['11.0.0.0/8'], cfg())).toThrow(/outside the operator/);
    expect(() => planEgress(['10.0.0.0/7'], cfg())).toThrow(/too broad|outside/);
    expect(() => planEgress(['203.0.113.0/24'], cfg())).toThrow(/outside the operator/);
    // empty operator list: no step CIDR at all
    expect(() => planEgress(['10.1.0.0/16'], cfg({ egress: [] }))).toThrow(/outside the operator/);
  });

  it('rejects a /1 split, /0 and over-broad prefixes (v4 >= /8, v6 >= /32)', () => {
    const wide = cfg({ egress: ['0.0.0.0/1', '128.0.0.0/1', '::/1'] });
    expect(() => planEgress(['0.0.0.0/1'], wide)).toThrow(/too broad/);
    expect(() => planEgress(['128.0.0.0/1'], wide)).toThrow(/too broad/);
    expect(() => planEgress(['::/1'], wide)).toThrow(/too broad/);
    expect(() => planEgress(['0.0.0.0/0'], cfg())).toThrow(/too broad/);
    // the operator list itself must obey the minimum prefix
    expect(() => planEgress(['10.1.0.0/16'], wide)).toThrow(/operator egress entry .* too broad/);
    expect(() => planEgress(['2001:db8::/31'], cfg({ egress: ['2001:db8::/31'] }))).toThrow(
      /too broad/,
    );
  });

  it('never opens IMDS, link-local or loopback, v4 and v6', () => {
    const open = cfg({
      egress: ['169.254.0.0/16', '127.0.0.0/8', '10.0.0.0/8', '2001:db8::/32', 'fd00:ec2::/32'],
    });
    expect(() => planEgress(['169.254.169.254/32'], open)).toThrow(/always-denied/);
    expect(() => planEgress(['169.254.0.0/16'], open)).toThrow(/always-denied/);
    expect(() => planEgress(['127.0.0.0/8'], open)).toThrow(/always-denied/);
    expect(() => planEgress(['fd00:ec2::254/128'], open)).toThrow(/always-denied/);
    expect(() => planEgress(['fd00:ec2::/32'], open)).not.toThrow(); // punched out via except
  });

  it('punches always-denied and configured ranges out of an allowed CIDR with except', () => {
    const c = cfg({
      egress: ['10.0.0.0/8', '2001:db8::/32'],
      denyCidrs: ['10.244.0.0/16', '10.96.0.0/12', '192.0.2.0/24', '2001:db8:1::/48'],
    });
    expect(planEgress(['10.0.0.0/8', '2001:db8::/32'], c).cidrs).toEqual([
      { cidr: '10.0.0.0/8', except: ['10.244.0.0/16', '10.96.0.0/12'] },
      { cidr: '2001:db8::/32', except: ['2001:db8:1::/48'] },
    ]);
    expect(() => planEgress(['10.244.1.0/24'], c)).toThrow(/always-denied/);
    expect(() =>
      planEgress(['10.0.0.0/8'], cfg({ egress: ['10.0.0.0/8'], denyCidrs: ['nope'] })),
    ).toThrow(/deny CIDR/);
    const p = buildNetworkPolicy(spec({ egress: ['10.0.0.0/8'] }), c) as any;
    expect(p.spec.egress.at(-1).to[0].ipBlock).toEqual({
      cidr: '10.0.0.0/8',
      except: ['10.244.0.0/16', '10.96.0.0/12'],
    });
  });

  it('refuses any step egress in air-gapped mode', () => {
    const c = cfg({ airgapped: true });
    expect(() => planEgress(['10.1.0.0/16'], c)).toThrow(/air-gapped/);
    expect(() => planEgress(['api.example.org'], c)).toThrow(/air-gapped/);
    expect(planEgress([], c)).toEqual({ cidrs: [], hosts: [] });
  });
});

describe('image validation', () => {
  it('only runs digest-pinned images allowlisted by exact repository path', () => {
    const c = cfg({ toolboxAllowlist: ['git+node'], runNodeImages: ['openagentix-worker'] });
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-git-node@${DIGEST}`, c)).not.toThrow();
    expect(() =>
      validateImage(`ghcr.io/open-agentix/openagentix-worker@${DIGEST}`, c),
    ).not.toThrow();
    // case is normalised
    expect(() => validateImage(`GHCR.io/Open-Agentix/Toolbox-Git-Node@${DIGEST}`, c)).not.toThrow();
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`, c)).toThrow(
      /allowlist/,
    );
    expect(() => validateImage(`ghcr.io/open-agentix/other@${DIGEST}`, c)).toThrow(
      /run node image/,
    );
    // exact path, not basename: nested paths do not match
    expect(() => validateImage(`ghcr.io/open-agentix/evil/toolbox-git-node@${DIGEST}`, c)).toThrow(
      /run node image/,
    );
    expect(() =>
      validateImage(`ghcr.io/open-agentix/evil/openagentix-worker@${DIGEST}`, c),
    ).toThrow(/run node image/);
    expect(() => validateImage(`evil.io/open-agentix/toolbox-git-node@${DIGEST}`, c)).toThrow(
      /registry/,
    );
    expect(() => validateImage('ghcr.io/open-agentix/toolbox-git-node:latest', c)).toThrow(
      /digest/,
    );
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-git-node:1@${DIGEST}`, c)).toThrow(
      /tag/,
    );
  });

  it('an empty toolbox allowlist allows no toolbox (fail closed)', () => {
    expect(() =>
      validateImage(`ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`, cfg({ toolboxAllowlist: [] })),
    ).toThrow(/allowlist/);
  });

  it('derives collision-free object names from UUIDs only', () => {
    expect(nodeObjectName(NODE.toUpperCase())).toBe(`oax-step-${NODE}`);
    expect(() => nodeObjectName('ABC_def')).toThrow(/UUID/);
    expect(() => nodeObjectName('abc.def')).toThrow(/UUID/);
  });
});

describe('resources and identity', () => {
  it('clamps step limits into [floor, operator ceiling] and never yields 0', () => {
    const c = cfg({ resources: { cpu: '1', memory: '1Gi' } });
    const lim = (cpus: number, memoryMb: number) => ({
      cpus,
      memoryMb,
      timeoutSeconds: 10,
      pids: 1,
    });
    expect(effectiveResources(lim(0.0001, 1), c)).toEqual({ cpu: '50m', memory: '32Mi' });
    expect(effectiveResources(lim(64, 99999), c)).toEqual({ cpu: '1000m', memory: '1024Mi' });
    expect(effectiveResources(lim(0.25, 200.2), c)).toEqual({ cpu: '250m', memory: '201Mi' });
    // ceiling below the floor wins
    expect(
      effectiveResources(lim(1, 1000), cfg({ resources: { cpu: '10m', memory: '16Mi' } })),
    ).toEqual({
      cpu: '10m',
      memory: '16Mi',
    });
    expect(() => effectiveResources(lim(Number.NaN, 1), c)).toThrow(/finite/);
    expect(() => effectiveResources(lim(Infinity, 1), c)).toThrow(/finite/);
    const job = buildJob(spec({ limits: lim(99, 99999) }), c) as any;
    expect(job.spec.template.spec.containers[0].resources.limits.cpu).toBe('1000m');
  });

  it('parses quantities', () => {
    expect(parseCpu('500m')).toBe(0.5);
    expect(parseCpu('2')).toBe(2);
    expect(() => parseCpu('x')).toThrow(/cpu/);
    expect(parseMemoryMb('512Mi')).toBe(512);
    expect(parseMemoryMb('1Gi')).toBe(1024);
    expect(parseMemoryMb('2048Ki')).toBe(2);
    expect(parseMemoryMb(String(1024 * 1024 * 3))).toBe(3);
    expect(parseMemoryMb('1G')).toBeCloseTo(953.67, 1);
    expect(parseMemoryMb('1M')).toBeCloseTo(0.954, 2);
    expect(parseMemoryMb('1024K')).toBeCloseTo(0.977, 2);
    expect(() => parseMemoryMb('lots')).toThrow(/memory/);
  });

  it('refuses the worker ServiceAccount and namespace for step Pods', () => {
    const mkr = (config: Record<string, unknown>) =>
      new KubernetesJobRunner({ client: new FakeKube(), config });
    expect(KubernetesJobRunnerConfigSchema.parse({}).serviceAccountName).toBe(
      'openagentix-run-node',
    );
    expect(() => mkr({ serviceAccountName: 'openagentix-worker' })).toThrow(/ServiceAccount/);
    expect(() => mkr({ serviceAccountName: 'w', workerServiceAccount: 'w' })).toThrow(
      /ServiceAccount/,
    );
    expect(() => mkr({ namespace: 'ctl', workerNamespace: 'ctl' })).toThrow(/namespace/);
    expect(() => mkr({ namespace: 'runs', workerNamespace: 'ctl' })).not.toThrow();
  });

  it('rejects empty controlPlane selectors', () => {
    expect(() =>
      KubernetesJobRunnerConfigSchema.parse({ controlPlane: { podSelector: {} } }),
    ).toThrow(/must not be empty/);
    expect(() =>
      KubernetesJobRunnerConfigSchema.parse({ controlPlane: { namespaceSelector: {} } }),
    ).toThrow(/must not be empty/);
  });

  it('rejects an empty control plane port list (an empty `ports` opens every port)', () => {
    expect(() =>
      KubernetesJobRunnerConfigSchema.parse({
        controlPlane: { namespaceSelector: { a: 'b' }, ports: [] },
      }),
    ).toThrow();
    // Defence in depth: a config that bypassed the schema never yields a port-less rule.
    const c = cfg();
    c.controlPlane.ports = [];
    expect(() => buildNetworkPolicy(spec({ egress: [] }), c)).toThrow(/port/);
    expect(
      () =>
        new KubernetesJobRunner({
          client: new FakeKube(),
          config: { namespace: 'runs', controlPlane: { cidrs: ['10.9.0.1/32'], ports: [] } },
        }),
    ).toThrow();
  });
});

describe('KubernetesJobRunner lifecycle', () => {
  const mk = (kube: FakeKube, extra: Record<string, unknown> = {}) =>
    new KubernetesJobRunner({
      client: kube,
      config: { namespace: 'runs', ...OPEN, ...extra },
      pollMs: 1,
      sleep: async () => undefined,
    });

  it('starts one suspended Job with owned NetworkPolicy and Secret, then unsuspends', async () => {
    const kube = new FakeKube();
    const warn = vi.fn();
    const r = new KubernetesJobRunner({
      client: kube,
      config: { namespace: 'runs', ...OPEN },
      warn,
    });
    const h = await r.startNode(spec(), {});
    expect(r.kind).toBe('kubernetes-job');
    expect(kube.calls).toEqual([
      'getNetworkPolicy',
      'createJob',
      'createNetworkPolicy',
      'createSecret',
      'patchJob',
    ]);
    expect(kube.patches).toEqual([{ spec: { suspend: false } }]);
    const owner = (kube.secrets.values().next().value as KubeObject).metadata.ownerReferences![0]!;
    expect(owner).toMatchObject({ kind: 'Job', uid: 'job-uid-1', controller: true });
    expect(owner).not.toHaveProperty('blockOwnerDeletion');
    // The NetworkPolicy has NO owner: the GC must not remove it in parallel with Pod termination.
    expect(kube.policies.values().next().value!.metadata.ownerReferences).toBeUndefined();
    expect(kube.policies.values().next().value!.metadata.labels).toMatchObject({
      'openagentix.io/node-id': NODE,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('api.example.org'));
    expect(h.nodeId).toBe(NODE);
  });

  it('wait: success, failure, timeout, missing job, polling', async () => {
    const kube = new FakeKube();
    const r = mk(kube);
    const h = await r.startNode(spec(), {});
    kube.statuses = [st(), st(), st({ succeeded: 1, active: 0, condition: { type: 'Complete' } })];
    await expect(h.wait()).resolves.toEqual({ exitCode: 0 });
    kube.statuses = [st({ succeeded: 1 })];
    await expect(h.wait()).resolves.toEqual({ exitCode: 0 });
    kube.statuses = [
      st({ failed: 1, condition: { type: 'Failed', reason: 'BackoffLimitExceeded' } }),
    ];
    await expect(h.wait()).resolves.toEqual({ exitCode: null, reason: 'failed' });
    kube.statuses = [st({ failed: 1, condition: { type: 'Failed', reason: 'DeadlineExceeded' } })];
    await expect(h.wait()).resolves.toEqual({ exitCode: null, reason: 'timeout' });
    kube.statuses = [st({ failed: 1 })];
    await expect(h.wait()).resolves.toEqual({ exitCode: null, reason: 'failed' });
    kube.statuses = [null];
    await expect(h.wait()).resolves.toEqual({ exitCode: null, reason: 'job_missing' });
  });

  it('wait: abort returns cancelled, also while sleeping', async () => {
    const kube = new FakeKube();
    kube.statuses = [st()];
    const r = new KubernetesJobRunner({
      client: kube,
      config: { namespace: 'runs', ...OPEN },
      pollMs: 5,
    });
    const h = await r.startNode(spec(), {});
    const ac = new AbortController();
    const p = h.wait(ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toEqual({ exitCode: null, reason: 'cancelled' });
    await expect(h.wait(ac.signal)).resolves.toEqual({ exitCode: null, reason: 'cancelled' });
  });

  it('stop deletes Job, Secret and NetworkPolicy by uid, idempotently', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    await h.stop('cancelled');
    await h.stop('cancelled');
    expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(0);
    expect(kube.calls.filter((c) => c === 'deleteJob')).toHaveLength(1);
    expect(kube.deleteUids).toEqual({
      job: 'job-uid-1',
      secret: 'secret-uid-1',
      policy: 'policy-uid-1',
    });
  });

  it('deletes the NetworkPolicy LAST, only after the Pods are gone', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    kube.calls.length = 0;
    kube.lingerPolls = 3; // Job still terminating (Pods running) for three polls
    await h.stop('timeout');
    const order = kube.calls;
    const del = order.indexOf('deleteJob');
    const pol = order.indexOf('deleteNetworkPolicy');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(pol).toBe(order.length - 1); // very last call
    // every poll that still saw the terminating Job happened before the policy was removed
    expect(order.slice(del, pol).filter((c) => c === 'getJob')).toHaveLength(4);
  });

  it('keeps the NetworkPolicy when the Pods are not confirmed gone', async () => {
    const kube = new FakeKube();
    const r = new KubernetesJobRunner({
      client: kube,
      config: { namespace: 'runs', ...OPEN },
      pollMs: 1,
      cleanupTimeoutMs: 3,
      sleep: async () => undefined,
    });
    const h = await r.startNode(spec(), {});
    kube.lingerPolls = 100;
    await expect(h.stop('timeout')).rejects.toThrow(/NetworkPolicy kept/);
    expect(kube.policies.size).toBe(1);
    expect(kube.calls).not.toContain('deleteNetworkPolicy');
    kube.lingerPolls = 0; // retry succeeds once the Pods are gone
    await expect(h.stop('timeout')).resolves.toBeUndefined();
    expect(kube.policies.size).toBe(0);
  });

  it('keeps the policy when deleting the Job failed; reports once; can be retried', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    kube.failOn.add('deleteJob');
    await expect(h.stop('timeout')).rejects.toThrow(/cleanup of run node .* boom deleteJob/);
    expect(kube.secrets.size).toBe(0);
    expect(kube.policies.size).toBe(1); // Pods may still run: policy stays
    kube.failOn.clear();
    await expect(h.stop('timeout')).resolves.toBeUndefined();
    expect(kube.policies.size).toBe(0);
  });

  it('reports secret and policy delete failures', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    kube.failOn.add('deleteSecret').add('deleteNetworkPolicy');
    await expect(h.stop('step_end')).rejects.toThrow(/boom deleteSecret; boom deleteNetworkPolicy/);
  });

  it('rolls back only what this call created when startup fails', async () => {
    for (const [op, left] of [
      ['createNetworkPolicy', []],
      ['createSecret', []],
      ['patchJob', []],
    ] as const) {
      const kube = new FakeKube();
      kube.failOn.add(op);
      await expect(mk(kube).startNode(spec(), {})).rejects.toThrow(`boom ${op}`);
      expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(left.length);
    }
  });

  it('never deletes anything after a failed createJob (e.g. 409 name collision)', async () => {
    const kube = new FakeKube();
    kube.failOn.add('createJob');
    await expect(mk(kube).startNode(spec(), {})).rejects.toThrow('boom createJob');
    expect(kube.calls).toEqual(['getNetworkPolicy', 'createJob']);
  });

  it('does not delete a NetworkPolicy or Secret it did not create (409 on create)', async () => {
    const kube = new FakeKube();
    kube.failOn.add('createNetworkPolicy');
    await expect(mk(kube).startNode(spec(), {})).rejects.toThrow('boom createNetworkPolicy');
    expect(kube.calls).not.toContain('deleteNetworkPolicy');
    expect(kube.calls).not.toContain('deleteSecret');
    expect(kube.calls).toContain('deleteJob');
    expect(kube.deleteUids.job).toBe('job-uid-1');
  });

  it('wait treats a Job with another uid as missing', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    kube.statuses = [st({ uid: 'someone-elses', succeeded: 1 })];
    await expect(h.wait()).resolves.toEqual({ exitCode: null, reason: 'job_missing' });
  });

  it('validates before any API call and honours an aborted signal', async () => {
    const kube = new FakeKube();
    const r = mk(kube);
    await expect(
      r.startNode(spec({ image: 'ghcr.io/open-agentix/toolbox-x:latest' }), {}),
    ).rejects.toThrow(/digest/);
    const ac = new AbortController();
    ac.abort();
    await expect(r.startNode(spec(), { signal: ac.signal })).rejects.toThrow(/aborted/);
    await expect(r.startNode(spec())).resolves.toBeDefined();
    expect(kube.calls.filter((c) => c === 'createJob')).toHaveLength(1);
  });

  it('whole-run execute is not supported (steps go through startNode)', async () => {
    await expect(mk(new FakeKube()).execute({} as never, {} as never)).rejects.toThrow(/startNode/);
  });
});

describe('default-deny prerequisite (fail closed)', () => {
  const mk = (kube: FakeKube) =>
    new KubernetesJobRunner({ client: kube, config: { namespace: 'runs', ...OPEN } });

  it('refuses to start when the default-deny policy is missing', async () => {
    const kube = new FakeKube();
    kube.defaultDeny = null;
    await expect(mk(kube).startNode(spec(), {})).rejects.toThrow(/no default-deny NetworkPolicy/);
    expect(kube.calls).toEqual(['getNetworkPolicy']);
  });

  it('refuses a policy that is not a real deny-all', async () => {
    const weak = (sp: Record<string, unknown>) =>
      ({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'default-deny-all' },
        spec: sp,
      }) as KubeObject;
    for (const sp of [
      { podSelector: {}, policyTypes: ['Ingress'] },
      { podSelector: {}, policyTypes: ['Egress'] },
      { podSelector: { matchLabels: { a: 'b' } }, policyTypes: ['Ingress', 'Egress'] },
      { podSelector: { matchExpressions: [] }, policyTypes: ['Ingress', 'Egress'] },
      { podSelector: {}, policyTypes: ['Ingress', 'Egress'], egress: [{}] },
      { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [{}] },
      {},
    ]) {
      const kube = new FakeKube();
      kube.defaultDeny = weak(sp);
      await expect(mk(kube).startNode(spec(), {})).rejects.toThrow(/default-deny/);
      expect(kube.calls).toEqual(['getNetworkPolicy']);
    }
    const noSpec = new FakeKube();
    noSpec.defaultDeny = { apiVersion: 'v1', kind: 'NetworkPolicy', metadata: { name: 'x' } };
    await expect(mk(noSpec).startNode(spec(), {})).rejects.toThrow(/default-deny/);
  });

  it('surfaces API errors of the check', async () => {
    const kube = new FakeKube();
    kube.failOn.add('getNetworkPolicy');
    await expect(mk(kube).startNode(spec(), {})).rejects.toThrow('boom getNetworkPolicy');
  });
});

describe('review round 2 hardening', () => {
  it('rejects operator resource ceilings that round to "no limit"', () => {
    for (const resources of [
      { cpu: '0', memory: '512Mi' },
      { cpu: '10m', memory: '512Mi' },
      { cpu: '500m', memory: '0' },
      { cpu: '500m', memory: '512' },
      { cpu: '500m', memory: '1000K' },
      { cpu: '500m', memory: '31Mi' },
    ]) {
      expect(() => validateResourceCeiling(resources)).toThrow(/below the minimum/);
      expect(
        () => new KubernetesJobRunner({ client: new FakeKube(), config: { resources } }),
      ).toThrow(/below the minimum/);
    }
    expect(() => validateResourceCeiling({ cpu: '50m', memory: '32Mi' })).not.toThrow();
  });

  it('emits canonical CIDRs in the NetworkPolicy', () => {
    const c = cfg({ egress: ['10.0.0.0/8', '2001:db8::/32'] });
    expect(planEgress(['10.1.2.3/16', '2001:0db8:0:0:0:0:0:0/32'], c).cidrs).toEqual([
      { cidr: '10.1.0.0/16', except: [] },
      { cidr: '2001:db8::/32', except: [] },
    ]);
    const p = buildNetworkPolicy(spec({ egress: ['10.1.2.3/16'] }), c) as any;
    expect(p.spec.egress.at(-1).to[0].ipBlock.cidr).toBe('10.1.0.0/16');
    expect(formatCidr(parseCidr('::/32')!)).toBe('::/32');
    expect(formatCidr(parseCidr('1:0:0:2:0:0:0:3/128')!)).toBe('1:0:0:2::3/128');
    expect(formatCidr(parseCidr('1:2:3:4:5:6:7:8/128')!)).toBe('1:2:3:4:5:6:7:8/128');
    expect(formatCidr(parseCidr('1:0:3:4:5:6:7:8/128')!)).toBe('1:0:3:4:5:6:7:8/128');
  });

  it('denies embedded IPv4-mapped/NAT64 forms and further cloud metadata addresses', () => {
    const c = cfg({
      egress: [
        '::ffff:0:0/96',
        '64:ff9b::/96',
        '168.63.129.0/24',
        '100.100.100.0/24',
        'fd20:ce::/32',
      ],
    });
    for (const bad of [
      '::ffff:a9fe:a9fe/128', // ::ffff:169.254.169.254
      '::ffff:7f00:1/128', // ::ffff:127.0.0.1
      '64:ff9b::a9fe:a9fe/128',
      '64:ff9b::7f00:1/128',
      '168.63.129.16/32',
      '100.100.100.200/32',
      'fd20:ce::254/128',
    ]) {
      expect(() => planEgress([bad], c), bad).toThrow(/always-denied/);
    }
    // a surrounding allowed range gets the denied part punched out
    expect(planEgress(['64:ff9b::/96'], c).cidrs[0]!.except).toEqual([
      '64:ff9b::a9fe:0/112',
      '64:ff9b::7f00:0/104',
    ]);
    expect(planEgress(['168.63.129.0/24'], c).cidrs[0]!.except).toEqual(['168.63.129.16/32']);
  });

  it('requires exactly one @ in image references', () => {
    const c = cfg();
    const base = 'ghcr.io/open-agentix/toolbox-git-node';
    expect(() => validateImage(`${base}@${DIGEST}@${DIGEST}`, c)).toThrow(/exactly one @/);
    expect(() => validateImage(`${base}@x@${DIGEST}`, c)).toThrow(/exactly one @/);
    expect(() => validateImage(`${base}@${DIGEST}`, c)).not.toThrow();
  });
});

describe('RBAC', () => {
  it('is minimal: namespaced verbs on exactly three resources, no wildcards, no pods', () => {
    const flat = REQUIRED_RBAC.flatMap((r) => r.resources.map((x) => `${r.apiGroups[0]}/${x}`));
    expect([...new Set(flat)].sort()).toEqual([
      '/secrets',
      'batch/jobs',
      'networking.k8s.io/networkpolicies',
    ]);
    // reading policies is limited to exactly the default-deny policy
    const reads = REQUIRED_RBAC.filter(
      (r) => r.resources[0] === 'networkpolicies' && r.verbs.includes('get'),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ resourceNames: ['default-deny-all'], verbs: ['get'] });
    expect(
      REQUIRED_RBAC.find((r) => r.resources[0] === 'networkpolicies' && !r.resourceNames)!.verbs,
    ).toEqual(['create', 'delete']);
    for (const r of REQUIRED_RBAC) {
      expect(r.verbs).not.toContain('*');
      expect(r.verbs).not.toContain('list');
      expect(r.verbs).not.toContain('watch');
      expect(r.verbs).not.toContain('update');
    }
    expect(REQUIRED_RBAC.find((r) => r.resources[0] === 'secrets')!.verbs).not.toContain('get');
  });

  it('matches the manifest example in docs/', () => {
    const doc = readFileSync(
      new URL('../../../docs/examples/kubernetes-job-runner-rbac.yaml', import.meta.url),
      'utf8',
    );
    expect(doc).toContain('kind: Role');
    expect(doc).not.toMatch(/kind: Cluster/);
    for (const rule of REQUIRED_RBAC) {
      expect(doc).toContain(`resources: [${rule.resources.join(', ')}]`);
      expect(doc).toContain(`verbs: [${rule.verbs.join(', ')}]`);
      if (rule.resourceNames) {
        expect(doc).toContain(`resourceNames: [${rule.resourceNames.join(', ')}]`);
      }
    }
  });
});

describe('InClusterKubeClient', () => {
  function client(handler: (req: any) => { status: number; body?: unknown }) {
    const reqs: any[] = [];
    const c = new InClusterKubeClient({
      apiServer: 'https://k8s',
      token: () => 't',
      transport: async (req) => {
        reqs.push(req);
        const r = handler(req);
        return { status: r.status, body: r.body ?? null };
      },
    });
    return { c, reqs };
  }
  const obj: KubeObject = { apiVersion: 'v1', kind: 'X', metadata: { name: 'n' } };

  it('maps calls to the namespaced REST paths and returns uids', async () => {
    const { c, reqs } = client((r) =>
      r.method === 'POST' ? { status: 201, body: { metadata: { uid: 'U' } } } : { status: 200 },
    );
    await expect(c.createJob('runs', obj)).resolves.toEqual({ uid: 'U' });
    await c.patchJob('runs', 'j', { a: 1 });
    await expect(c.createSecret('runs', obj)).resolves.toEqual({ uid: 'U' });
    await expect(c.createNetworkPolicy('runs', obj)).resolves.toEqual({ uid: 'U' });
    await c.deleteJob('runs', 'j', 'JU');
    await c.deleteSecret('runs', 's', 'SU');
    await c.deleteNetworkPolicy('runs', 'p', 'PU');
    await c.deleteNetworkPolicy('runs', 'p');
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /apis/batch/v1/namespaces/runs/jobs',
      'PATCH /apis/batch/v1/namespaces/runs/jobs/j',
      'POST /api/v1/namespaces/runs/secrets',
      'POST /apis/networking.k8s.io/v1/namespaces/runs/networkpolicies',
      'DELETE /apis/batch/v1/namespaces/runs/jobs/j',
      'DELETE /api/v1/namespaces/runs/secrets/s',
      'DELETE /apis/networking.k8s.io/v1/namespaces/runs/networkpolicies/p',
      'DELETE /apis/networking.k8s.io/v1/namespaces/runs/networkpolicies/p',
    ]);
    expect(reqs[1].contentType).toBe('application/merge-patch+json');
    expect(reqs[4].body).toEqual({ propagationPolicy: 'Foreground', preconditions: { uid: 'JU' } });
    expect(reqs[5].body).toEqual({ preconditions: { uid: 'SU' } });
    expect(reqs[6].body).toEqual({ preconditions: { uid: 'PU' } });
    expect(reqs[7].body).toBeUndefined();
  });

  it('treats a failed uid precondition (409) as "not ours": nothing to delete', async () => {
    const { c } = client(() => ({ status: 409, body: { message: 'precondition failed' } }));
    await expect(c.deleteJob('runs', 'j', 'JU')).resolves.toBeUndefined();
    await expect(c.deleteSecret('runs', 's', 'SU')).resolves.toBeUndefined();
    // without a precondition a 409 is a real error
    await expect(c.deleteSecret('runs', 's')).rejects.toThrow(/HTTP 409/);
  });

  it('reads a NetworkPolicy (404 -> null, errors surfaced)', async () => {
    const ok = client(() => ({ status: 200, body: { kind: 'NetworkPolicy' } }));
    await expect(ok.c.getNetworkPolicy('runs', 'default-deny-all')).resolves.toEqual({
      kind: 'NetworkPolicy',
    });
    expect(ok.reqs[0].path).toBe(
      '/apis/networking.k8s.io/v1/namespaces/runs/networkpolicies/default-deny-all',
    );
    await expect(
      client(() => ({ status: 404 })).c.getNetworkPolicy('runs', 'x'),
    ).resolves.toBeNull();
    await expect(client(() => ({ status: 403 })).c.getNetworkPolicy('runs', 'x')).rejects.toThrow(
      /get NetworkPolicy/,
    );
  });

  it('refuses a plain-http API server unless explicitly allowed', () => {
    expect(() => new InClusterKubeClient({ apiServer: 'http://k8s', token: 't' })).toThrow(/https/);
    expect(
      () =>
        new InClusterKubeClient({
          apiServer: 'http://127.0.0.1:8001',
          token: 't',
          allowInsecure: true,
        }),
    ).not.toThrow();
    expect(() => new InClusterKubeClient({ apiServer: 'https://k8s', token: 't' })).not.toThrow();
  });

  it('treats 404 on delete as success and surfaces other errors', async () => {
    const nf = client(() => ({ status: 404 }));
    await expect(nf.c.deleteJob('runs', 'j')).resolves.toBeUndefined();
    const err = client(() => ({ status: 403, body: { message: 'forbidden: nope' } }));
    await expect(err.c.deleteSecret('runs', 's')).rejects.toThrow(/HTTP 403: forbidden: nope/);
    await expect(err.c.createJob('runs', obj)).rejects.toThrow(/create Job failed/);
    await expect(err.c.patchJob('runs', 'j', {})).rejects.toThrow(/patch Job/);
    await expect(err.c.createSecret('runs', obj)).rejects.toThrow(/create Secret/);
    await expect(err.c.createNetworkPolicy('runs', obj)).rejects.toThrow(/create NetworkPolicy/);
    await expect(err.c.getJob('runs', 'j')).rejects.toThrow(/get Job/);
    const nouid = client(() => ({ status: 201, body: {} }));
    await expect(nouid.c.createJob('runs', obj)).rejects.toThrow(/without uid/);
  });

  it('parses Job status and conditions', async () => {
    const mkc = (body: unknown, status = 200) => client(() => ({ status, body })).c;
    await expect(mkc(null, 404).getJob('runs', 'j')).resolves.toBeNull();
    await expect(
      mkc({
        metadata: { uid: 'u' },
        status: {
          failed: 1,
          conditions: [
            { type: 'Suspended', status: 'False' },
            { type: 'Failed', status: 'True', reason: 'DeadlineExceeded', message: 'm' },
          ],
        },
      }).getJob('runs', 'j'),
    ).resolves.toEqual({
      uid: 'u',
      succeeded: 0,
      failed: 1,
      active: 0,
      condition: { type: 'Failed', reason: 'DeadlineExceeded', message: 'm' },
    });
    await expect(mkc({}).getJob('runs', 'j')).resolves.toEqual({
      uid: '',
      succeeded: 0,
      failed: 0,
      active: 0,
    });
  });

  it('rejects hostile namespaces', async () => {
    const { c } = client(() => ({ status: 200 }));
    await expect(c.getJob('../x', 'j')).rejects.toThrow(/invalid Kubernetes namespace/);
  });

  it('fromEnv requires an in-cluster environment', () => {
    expect(() => InClusterKubeClient.fromEnv({})).toThrow(/not running in a cluster/);
  });
});

describe('worker wiring helpers', () => {
  const IMG = `ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`;
  const mk = (over: Record<string, unknown> = {}) =>
    new KubernetesJobRunner({
      client: new FakeKube(),
      config: {
        namespace: 'runs',
        toolboxAllowlist: ['trivy'],
        image: IMG,
        toolboxImages: { trivy: IMG },
        ...over,
      },
    });

  it('selects the configured image and fails closed for unknown toolboxes and harnesses', () => {
    const r = mk();
    expect(r.imageFor(undefined)).toBe(IMG);
    expect(r.imageFor('trivy')).toBe(IMG);
    expect(() => r.imageFor('nmap')).toThrow(/no image is configured for toolbox "nmap"/);
    expect(() => r.imageFor(undefined, 'claude-code')).toThrow(/not supported/);
    expect(() => mk({ image: undefined }).imageFor(undefined)).toThrow(/no run node image/);
  });

  it('hands the operator ceilings to the worker as default limits', () => {
    expect(mk().defaultLimits()).toEqual({ cpus: 0.5, memoryMb: 512, pids: 256 });
  });

  it('rejects unpinned, foreign-registry or non-allowlisted images at construction', () => {
    expect(() => mk({ image: 'ghcr.io/open-agentix/toolbox-trivy:latest' })).toThrow(/digest/);
    expect(() => mk({ image: `docker.io/x/toolbox-trivy@${DIGEST}` })).toThrow(/registry/);
    expect(() =>
      mk({ toolboxImages: { nmap: `ghcr.io/open-agentix/toolbox-nmap@${DIGEST}` } }),
    ).toThrow(/allowlist/);
  });
});
