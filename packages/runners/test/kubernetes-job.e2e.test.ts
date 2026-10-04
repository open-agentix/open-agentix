import { describe, expect, it } from 'vitest';
import { InClusterKubeClient, KubernetesJobRunner } from '../src/index.js';

/**
 * Opt-in end-to-end test against a real cluster (kind). Needs:
 *   OAX_TEST_KIND=1
 *   OAX_TEST_KUBE_API    e.g. http://127.0.0.1:8001 (`kubectl proxy`), or https URL + OAX_TEST_KUBE_TOKEN
 *   OAX_TEST_IMAGE       digest-pinned image under OAX_TEST_REGISTRY (default ghcr.io/open-agentix)
 * It creates the Job, NetworkPolicy and Secret, then removes them and checks the Job is gone.
 */
const enabled = process.env.OAX_TEST_KIND === '1' && !!process.env.OAX_TEST_KUBE_API;

describe.skipIf(!enabled)('kubernetes-job runner on a real cluster (OAX_TEST_KIND=1)', () => {
  it('starts and removes a run node', async () => {
    const client = new InClusterKubeClient({
      apiServer: process.env.OAX_TEST_KUBE_API!,
      token: process.env.OAX_TEST_KUBE_TOKEN ?? 'unused-with-kubectl-proxy',
      allowInsecure: process.env.OAX_TEST_KUBE_API!.startsWith('http://'),
    });
    const runner = new KubernetesJobRunner({
      client,
      config: {
        namespace: process.env.OAX_TEST_NAMESPACE ?? 'openagentix-runs',
        registry: process.env.OAX_TEST_REGISTRY ?? 'ghcr.io/open-agentix',
        runNodeImages: ['openagentix-worker'],
        toolboxAllowlist: ['git+node'],
      },
    });
    const nodeId = crypto.randomUUID();
    const h = await runner.startNode(
      {
        runId: crypto.randomUUID(),
        nodeId,
        steps: ['e2e'],
        image: process.env.OAX_TEST_IMAGE!,
        controlUrl: 'https://oax.invalid',
        runToken: 'oaxrt.e2e',
        limits: { cpus: 0.25, memoryMb: 128, timeoutSeconds: 60, pids: 64 },
        egress: [],
      },
      {},
    );
    expect(await client.getJob(runner.config.namespace, `oax-step-${nodeId}`)).not.toBeNull();
    await h.stop('cancelled');
    for (let i = 0; i < 30; i++) {
      if ((await client.getJob(runner.config.namespace, `oax-step-${nodeId}`)) === null) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Job was not removed');
  });
});
