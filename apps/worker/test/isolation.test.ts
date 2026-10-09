/* eslint-disable @typescript-eslint/no-explicit-any -- manifests are inspected structurally */
import { loadConfig } from '@openagentix/api';
import type { ContainerRunner } from '@openagentix/runners';
import type { JobStatus, KubeClient, KubeObject } from '@openagentix/runners';
import { describe, expect, it } from 'vitest';
import { buildIsolation, createKubernetesJobRunner } from '../src/isolation.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMAGE = `ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`;
const NODE = '3b0f6c2e-7d1a-4c53-9a39-0f4b3c1d2e55';
const RUN = '8f14e45f-ceea-467a-9575-1d5a1c3e9f10';
const TOKEN = 'oaxrt.SUPER-SECRET-RUN-TOKEN';

const base = {
  OAX_DATABASE_URL: 'memory://',
  NODE_ENV: 'test',
  OAX_RUNNERS_ENABLED: 'kubernetes-job',
  OAX_K8S_JOB_ENABLED: 'true',
  OAX_NODE_CONTROL_URL: 'https://oax-api.oax.svc.cluster.local',
  OAX_K8S_IMAGE: IMAGE,
  OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR: '{"kubernetes.io/metadata.name":"oax"}',
  OAX_TOOLBOX_ALLOWLIST: 'trivy',
  OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
  OAX_K8S_NAMESPACE: 'runs',
};

/** In-memory Kubernetes API: records every call and the objects that exist. */
class FakeKube implements KubeClient {
  calls: string[] = [];
  jobs = new Map<string, KubeObject>();
  secrets = new Map<string, KubeObject>();
  policies = new Map<string, KubeObject>();
  jobStatus: JobStatus | null = null;
  async createJob(_ns: string, job: KubeObject) {
    this.calls.push('createJob');
    this.jobs.set(job.metadata.name, job);
    this.jobStatus = { uid: 'job-1', succeeded: 0, failed: 0, active: 1 };
    return { uid: 'job-1' };
  }
  async patchJob() {
    this.calls.push('patchJob');
  }
  async getJob(): Promise<JobStatus | null> {
    return this.jobStatus;
  }
  async deleteJob(_ns: string, name: string) {
    this.calls.push('deleteJob');
    this.jobs.delete(name);
    this.jobStatus = null;
  }
  async createSecret(_ns: string, s: KubeObject) {
    this.calls.push('createSecret');
    this.secrets.set(s.metadata.name, s);
    return { uid: 'secret-1' };
  }
  async deleteSecret(_ns: string, name: string) {
    this.calls.push('deleteSecret');
    this.secrets.delete(name);
  }
  async createNetworkPolicy(_ns: string, p: KubeObject) {
    this.calls.push('createNetworkPolicy');
    this.policies.set(p.metadata.name, p);
    return { uid: 'policy-1' };
  }
  async getNetworkPolicy(): Promise<KubeObject | null> {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'default-deny-all' },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    } as KubeObject;
  }
  async deleteNetworkPolicy(_ns: string, name: string) {
    this.calls.push('deleteNetworkPolicy');
    this.policies.delete(name);
  }
}

describe('worker isolation wiring', () => {
  it('is off by default: no runner, no isolation', () => {
    const config = loadConfig({
      OAX_DATABASE_URL: 'memory://',
      NODE_ENV: 'test',
    });
    expect(createKubernetesJobRunner(config, { client: new FakeKube() })).toBeUndefined();
    expect(buildIsolation(config, {})).toBeUndefined();
  });

  it('does not touch the cluster client when disabled', () => {
    const config = loadConfig({ ...base, OAX_K8S_JOB_ENABLED: 'false', OAX_RUNNERS_ENABLED: '' });
    // would throw ("not running in a cluster") if it tried to build the in-cluster client
    expect(createKubernetesJobRunner(config)).toBeUndefined();
  });

  it('fails closed when enabled outside a cluster', () => {
    const config = loadConfig(base);
    const saved = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
      expect(() => createKubernetesJobRunner(config)).toThrow(/not running in a cluster/);
    } finally {
      if (saved !== undefined) process.env.KUBERNETES_SERVICE_HOST = saved;
    }
  });

  it('registers the runner under its kind with its own https control URL and limits', () => {
    const config = loadConfig(base);
    const kubernetes = createKubernetesJobRunner(config, { client: new FakeKube() })!;
    const iso = buildIsolation(config, { kubernetes })!;
    expect(Object.keys(iso.runners)).toEqual(['kubernetes-job']);
    expect(iso.controlUrl).toBe('https://oax-api.oax.svc.cluster.local');
    expect(iso.controlUrls).toEqual({ 'kubernetes-job': iso.controlUrl });
    expect(iso.limits).toEqual({ cpus: 0.5, memoryMb: 512, pids: 256 });
    expect(kubernetes.imageFor(undefined)).toBe(IMAGE);
  });

  it('can run next to the container runner without sharing its control URL', () => {
    const config = loadConfig(base);
    const kubernetes = createKubernetesJobRunner(config, { client: new FakeKube() })!;
    const container = { defaultLimits: () => ({ cpus: 1, memoryMb: 256, pids: 64 }) };
    const iso = buildIsolation(
      {
        ...config,
        runners: {
          ...config.runners,
          container: { enabled: true, nodeControlUrl: 'http://engine-net-api:8080' },
        },
      },
      { container: container as unknown as ContainerRunner, kubernetes },
    )!;
    expect(iso.controlUrls).toEqual({
      container: 'http://engine-net-api:8080',
      'kubernetes-job': 'https://oax-api.oax.svc.cluster.local',
    });
    expect(iso.limits).toEqual({ cpus: 1, memoryMb: 256, pids: 64 });
  });

  it('starts a hardened Job from the real config and cleans everything up on cancel', async () => {
    const kube = new FakeKube();
    const warnings: string[] = [];
    const runner = createKubernetesJobRunner(loadConfig(base), {
      client: kube,
      warn: (m) => warnings.push(m),
    })!;
    const handle = await runner.startNode(
      {
        runId: RUN,
        nodeId: NODE,
        steps: ['scan'],
        image: runner.imageFor(undefined),
        controlUrl: 'https://oax-api.oax.svc.cluster.local',
        runToken: TOKEN,
        limits: { cpus: 2, memoryMb: 4096, timeoutSeconds: 90, pids: 64 },
        egress: [],
      },
      {},
    );
    const name = `oax-step-${NODE}`;
    const job = kube.jobs.get(name) as any;
    const pod = job.spec.template.spec;
    const c = pod.containers[0];
    expect(kube.calls).toEqual(['createJob', 'createNetworkPolicy', 'createSecret', 'patchJob']);
    // per-run name and labels
    expect(job.metadata.labels['openagentix.io/run-id']).toBe(RUN);
    expect(job.metadata.labels['openagentix.io/node-id']).toBe(NODE);
    // hardening
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(c.securityContext).toMatchObject({
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    // limits clamped to the operator ceiling (500m / 512Mi), deadline from the step timeout
    expect(c.resources.limits).toMatchObject({ cpu: '500m', memory: '512Mi' });
    expect(job.spec).toMatchObject({ activeDeadlineSeconds: 90, ttlSecondsAfterFinished: 600 });
    // the token lives only in the Secret, never in the Job, the policy or the log
    expect(JSON.stringify(job)).not.toContain(TOKEN);
    expect(JSON.stringify([...kube.policies.values()])).not.toContain(TOKEN);
    expect(warnings.join('\n')).not.toContain(TOKEN);
    expect(Buffer.from((kube.secrets.get(name) as any).data.token, 'base64').toString()).toBe(
      TOKEN,
    );
    // the control node is the only extra destination; no ingress
    const policy = kube.policies.get(name) as any;
    expect(policy.spec.ingress).toEqual([]);
    expect(policy.spec.egress.at(-1).ports).toEqual([{ protocol: 'TCP', port: 443 }]);

    await handle.stop('cancelled');
    expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(0);
  });

  it('reports a timed out step as timeout and still cleans up', async () => {
    const kube = new FakeKube();
    const runner = createKubernetesJobRunner(loadConfig(base), { client: kube })!;
    const handle = await runner.startNode(
      {
        runId: RUN,
        nodeId: NODE,
        steps: ['scan'],
        image: IMAGE,
        controlUrl: 'https://oax-api.oax.svc.cluster.local',
        runToken: TOKEN,
        limits: { cpus: 0.1, memoryMb: 64, timeoutSeconds: 5, pids: 64 },
        egress: [],
      },
      {},
    );
    kube.jobStatus = {
      uid: 'job-1',
      succeeded: 0,
      failed: 1,
      active: 0,
      condition: { type: 'Failed', reason: 'DeadlineExceeded', message: '' },
    };
    expect(await handle.wait()).toEqual({ exitCode: null, reason: 'timeout' });
    await handle.stop('timeout');
    expect(kube.jobs.size + kube.secrets.size + kube.policies.size).toBe(0);
  });
});
