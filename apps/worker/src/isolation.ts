import type { Config } from '@openagentix/api';
import type { ContainerRunner } from '@openagentix/runners';
import { InClusterKubeClient, KubernetesJobRunner, type KubeClient } from '@openagentix/runners';
import type { WorkerOptions } from './worker.js';

type Isolation = NonNullable<WorkerOptions['isolation']>;

/**
 * Builds the opt-in Kubernetes Job runner. Returns `undefined` unless the operator enabled it
 * (`OAX_RUNNERS_ENABLED` contains `kubernetes-job` AND `OAX_K8S_JOB_ENABLED=true`). Fail closed:
 * outside a cluster (no in-cluster client) or with a config the runner rejects it throws, so the
 * process refuses to start instead of silently running isolated steps without isolation.
 */
export function createKubernetesJobRunner(
  config: Config,
  deps: { client?: KubeClient; warn?: (message: string) => void } = {},
): KubernetesJobRunner | undefined {
  const job = config.runners.kubernetesJob;
  if (!job.enabled || !config.runners.enabled.includes('kubernetes-job')) return undefined;
  const { enabled: _enabled, nodeControlUrl: _url, ...runnerConfig } = job;
  const runner = new KubernetesJobRunner({
    client: deps.client ?? InClusterKubeClient.fromEnv(),
    config: runnerConfig,
    ...(deps.warn ? { warn: deps.warn } : {}),
  });
  // An explicit opt-in, but it hands a Kubernetes API credential to untrusted step code: say so.
  if (runner.config.automountServiceAccountToken) {
    deps.warn?.(
      `OAX_K8S_AUTOMOUNT_SA_TOKEN=true: run Pods get the API token of ServiceAccount "${runner.config.serviceAccountName}"; make sure it has no RoleBinding`,
    );
  }
  return runner;
}

/** The isolating runners of this worker (container and/or Kubernetes Job), or undefined if none. */
export function buildIsolation(
  config: Config,
  runners: { container?: ContainerRunner; kubernetes?: KubernetesJobRunner },
): Isolation | undefined {
  const container = config.runners.container;
  const k8s = config.runners.kubernetesJob;
  const containerUrl = runners.container && container.nodeControlUrl;
  const k8sUrl = runners.kubernetes && k8s.nodeControlUrl;
  if (!runners.container && !runners.kubernetes) return undefined;
  if ((runners.container && !containerUrl) || (runners.kubernetes && !k8sUrl)) return undefined;
  const limits = (runners.container ?? runners.kubernetes)!.defaultLimits();
  return {
    runners: {
      ...(runners.container ? { container: runners.container } : {}),
      ...(runners.kubernetes ? { 'kubernetes-job': runners.kubernetes } : {}),
    },
    controlUrl: (containerUrl || k8sUrl) as string,
    controlUrls: {
      ...(containerUrl ? { container: containerUrl } : {}),
      ...(k8sUrl ? { 'kubernetes-job': k8sUrl } : {}),
    },
    // Ordinary nodes get the default memory, not the ceiling (OAX_CONTAINER_MEMORY_MB).
    limits,
  };
}
