import type { Metrics } from '../metrics.js';
import { providerLabel } from '../metric-labels.js';
import type { StepMetric } from './step-writer.js';

/** Resolves a provider instance name in a run's scope to a closed family label. */
export type ProviderLabelResolver = (scope: StepMetric['scope'], name: string) => Promise<string>;

/**
 * Records the cost and token counters of one committed step (ADR 0015 S5). The provider label is
 * the **family** of the instance (resolved in the run's scope: the instance name of a tenant
 * connection is tenant-chosen text and is never a label). Without a resolver, or when it fails,
 * the instance name is kept only if it is itself a member of the closed set; otherwise `other`.
 */
export async function recordStepMetric(
  metrics: Metrics,
  resolve: ProviderLabelResolver | undefined,
  m: StepMetric,
): Promise<void> {
  let provider = 'tool';
  if (m.provider !== null) {
    try {
      provider = providerLabel(resolve ? await resolve(m.scope, m.provider) : m.provider);
    } catch {
      provider = providerLabel(m.provider);
    }
  }
  metrics.cost(provider, m.costMicros);
  if (m.tokens) {
    metrics.modelCall({
      provider,
      model: m.model ?? undefined,
      via: m.via === 'proxy' ? 'proxy' : 'in-process',
      tokens: m.tokens,
      seconds: m.seconds ?? undefined,
      failed: m.failed,
    });
  }
}
