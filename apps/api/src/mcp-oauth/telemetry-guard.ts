import { ContextGuard, type GuardReport } from '@openagentix/core';
import type { SecretRegistry } from './secret-registry.js';

/**
 * The guard of span attributes: the usual `ContextGuard` plus the secret registry. The registry
 * expires and forgets tokens; a plain guard would keep every token it was told about for the
 * lifetime of the process and test each of them with a linear scan.
 */
export class RegistryGuard extends ContextGuard {
  constructor(private readonly registry: SecretRegistry) {
    super();
  }

  override text(input: string): { text: string; report: GuardReport } {
    const r = super.text(input);
    const out = this.registry.scrub(r.text);
    if (out !== r.text) {
      r.report.secrets.total++;
      r.report.secrets.kinds['known-secret'] = (r.report.secrets.kinds['known-secret'] ?? 0) + 1;
    }
    return { text: out, report: r.report };
  }
}
