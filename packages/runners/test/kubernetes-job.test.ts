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
  statuses: (JobStatus | null)[] = [];
  failOn = new Set<string>();

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
    return this.statuses.length > 1 ? (this.statuses.shift() ?? null) : (this.statuses[0] ?? null);
  }
  async deleteJob(_ns: string, name: string) {
    this.maybeFail('deleteJob');
    this.jobs.delete(name);
  }
  async createSecret(_ns: string, s: KubeObject) {
    this.maybeFail('createSecret');
    this.secrets.set(s.metadata.name, s);
  }
  async deleteSecret(_ns: string, name: string) {
    this.maybeFail('deleteSecret');
    this.secrets.delete(name);
  }
  async createNetworkPolicy(_ns: string, p: KubeObject) {
    this.maybeFail('createNetworkPolicy');
    this.policies.set(p.metadata.name, p);
  }
  async deleteNetworkPolicy(_ns: string, name: string) {
    this.maybeFail('deleteNetworkPolicy');
    this.policies.delete(name);
  }
}

const st = (over: Partial<JobStatus> = {}): JobStatus => ({
  uid: 'u',
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
    expect(c.resources.limits).toEqual({ cpu: '0.5', memory: '256Mi', 'ephemeral-storage': '1Gi' });
    expect(c.resources.requests).toEqual({ cpu: '0.5', memory: '256Mi' });
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
    expect(() => buildJob(spec({ runId: 'bad id!' }), cfg())).toThrow(/runId/);
    expect(() => buildJob(spec({ nodeId: '!!!' }), cfg())).toThrow(/nodeId|Kubernetes name/);
  });

  it('builds a Secret with the run token only', () => {
    const s = buildSecret(spec(), 'runs') as any;
    expect(Object.keys(s.data)).toEqual(['token']);
    expect(Buffer.from(s.data.token, 'base64').toString()).toBe(TOKEN);
    expect(s.immutable).toBe(true);
  });

  it('builds a deny-by-default NetworkPolicy with an explicit allowlist', () => {
    const p = buildNetworkPolicy(spec(), cfg({ egress: ['192.0.2.0/24'] })) as any;
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
    expect(egress.slice(2).map((e: any) => e.to[0].ipBlock.cidr)).toEqual(
      ['10.1.0.0/16', '192.0.2.0/24'].sort(),
    );
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

describe('egress planning and image validation', () => {
  it('classifies CIDRs and hosts, refuses open-ended entries', () => {
    expect(planEgress(['b.example.org', '10.0.0.0/8', ' ', '*.x.io'], ['10.0.0.0/8'])).toEqual({
      cidrs: ['10.0.0.0/8'],
      hosts: ['*.x.io', 'b.example.org'],
    });
    expect(planEgress(['2001:db8::/32'], []).cidrs).toEqual(['2001:db8::/32']);
    expect(() => planEgress(['0.0.0.0/0'], [])).toThrow(/all destinations/);
    expect(() => planEgress(['10.0.0.256/8'], [])).toThrow(/valid CIDR/);
    expect(() => planEgress(['10.0.0.1'], [])).toThrow(/valid CIDR/);
    expect(() => planEgress(['bad host'], [])).toThrow(/neither/);
    expect(isCidr('1.2.3.4/33')).toBe(false);
  });

  it('only runs digest-pinned, allowlisted images from the registry', () => {
    const c = cfg({ toolboxAllowlist: ['git+node'], runNodeImages: ['openagentix-worker'] });
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-git-node@${DIGEST}`, c)).not.toThrow();
    expect(() =>
      validateImage(`ghcr.io/open-agentix/openagentix-worker@${DIGEST}`, c),
    ).not.toThrow();
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`, c)).toThrow(
      /allowlist/,
    );
    expect(() => validateImage(`ghcr.io/open-agentix/other@${DIGEST}`, c)).toThrow(
      /run node image/,
    );
    expect(() => validateImage(`evil.io/open-agentix/toolbox-git-node@${DIGEST}`, c)).toThrow(
      /registry/,
    );
    expect(() => validateImage('ghcr.io/open-agentix/toolbox-git-node:latest', c)).toThrow(
      /digest/,
    );
    expect(() => validateImage(`ghcr.io/open-agentix/toolbox-git-node:1@${DIGEST}`, c)).toThrow(
      /tag/,
    );
    // empty allowlist = any toolbox
    expect(() =>
      validateImage(`ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`, cfg()),
    ).not.toThrow();
  });

  it('derives valid object names', () => {
    expect(nodeObjectName('ABC_def.1')).toBe('oax-step-abc-def-1');
    expect(nodeObjectName('x'.repeat(80)).length).toBeLessThanOrEqual(57);
  });
});

describe('KubernetesJobRunner lifecycle', () => {
  const mk = (kube: FakeKube, extra: Record<string, unknown> = {}) =>
    new KubernetesJobRunner({
      client: kube,
      config: { namespace: 'runs', ...extra },
      pollMs: 1,
      sleep: async () => undefined,
    });

  it('starts one suspended Job with owned NetworkPolicy and Secret, then unsuspends', async () => {
    const kube = new FakeKube();
    const warn = vi.fn();
    const r = new KubernetesJobRunner({ client: kube, config: { namespace: 'runs' }, warn });
    const h = await r.startNode(spec(), {});
    expect(r.kind).toBe('kubernetes-job');
    expect(kube.calls).toEqual(['createJob', 'createNetworkPolicy', 'createSecret', 'patchJob']);
    expect(kube.patches).toEqual([{ spec: { suspend: false } }]);
    const owner = (kube.secrets.values().next().value as KubeObject).metadata.ownerReferences![0]!;
    expect(owner).toMatchObject({ kind: 'Job', uid: 'job-uid-1', controller: true });
    expect(kube.policies.values().next().value!.metadata.ownerReferences).toEqual([owner]);
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
    const r = new KubernetesJobRunner({ client: kube, config: { namespace: 'runs' }, pollMs: 5 });
    const h = await r.startNode(spec(), {});
    const ac = new AbortController();
    const p = h.wait(ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toEqual({ exitCode: null, reason: 'cancelled' });
    await expect(h.wait(ac.signal)).resolves.toEqual({ exitCode: null, reason: 'cancelled' });
  });

  it('stop deletes Job, Secret and NetworkPolicy, idempotently', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    await h.stop('cancelled');
    await h.stop('cancelled');
    expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(0);
    expect(kube.calls.filter((c) => c === 'deleteJob')).toHaveLength(1);
  });

  it('stop tries everything, reports failures once and can be retried', async () => {
    const kube = new FakeKube();
    const h = await mk(kube).startNode(spec(), {});
    kube.failOn.add('deleteJob');
    await expect(h.stop('timeout')).rejects.toThrow(/cleanup of run node .* boom deleteJob/);
    expect(kube.secrets.size + kube.policies.size).toBe(0);
    kube.failOn.clear();
    await expect(h.stop('timeout')).resolves.toBeUndefined();
    expect(kube.jobs.size).toBe(0);
  });

  it('rolls back a half-created node when startup fails', async () => {
    for (const op of ['createNetworkPolicy', 'createSecret', 'patchJob']) {
      const kube = new FakeKube();
      kube.failOn.add(op);
      await expect(mk(kube).startNode(spec(), {})).rejects.toThrow(`boom ${op}`);
      expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(0);
    }
    const kube = new FakeKube();
    kube.failOn.add('createJob');
    await expect(mk(kube).startNode(spec(), {})).rejects.toThrow('boom createJob');
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

describe('RBAC', () => {
  it('is minimal: namespaced verbs on exactly three resources, no wildcards, no pods', () => {
    const flat = REQUIRED_RBAC.flatMap((r) => r.resources.map((x) => `${r.apiGroups[0]}/${x}`));
    expect(flat.sort()).toEqual(['/secrets', 'batch/jobs', 'networking.k8s.io/networkpolicies']);
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

  it('maps calls to the namespaced REST paths', async () => {
    const { c, reqs } = client((r) =>
      r.method === 'POST' && r.path.endsWith('/jobs')
        ? { status: 201, body: { metadata: { uid: 'U' } } }
        : { status: 200 },
    );
    await expect(c.createJob('runs', obj)).resolves.toEqual({ uid: 'U' });
    await c.patchJob('runs', 'j', { a: 1 });
    await c.createSecret('runs', obj);
    await c.createNetworkPolicy('runs', obj);
    await c.deleteJob('runs', 'j');
    await c.deleteSecret('runs', 's');
    await c.deleteNetworkPolicy('runs', 'p');
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /apis/batch/v1/namespaces/runs/jobs',
      'PATCH /apis/batch/v1/namespaces/runs/jobs/j',
      'POST /api/v1/namespaces/runs/secrets',
      'POST /apis/networking.k8s.io/v1/namespaces/runs/networkpolicies',
      'DELETE /apis/batch/v1/namespaces/runs/jobs/j',
      'DELETE /api/v1/namespaces/runs/secrets/s',
      'DELETE /apis/networking.k8s.io/v1/namespaces/runs/networkpolicies/p',
    ]);
    expect(reqs[1].contentType).toBe('application/merge-patch+json');
    expect(reqs[4].body).toEqual({ propagationPolicy: 'Background' });
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
