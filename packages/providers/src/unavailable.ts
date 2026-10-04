import { OaxError } from '@openagentix/core';
import type { Classification } from '@openagentix/core';
import type { ChatResponse, ModelProvider, ProviderKind } from './types.js';

/**
 * Placeholder for a configured provider that could not be built (missing secret, forbidden
 * endpoint, ...). A run that uses it fails with the real reason instead of silently falling back to
 * another provider of the same name.
 */
export class UnavailableProvider implements ModelProvider {
  readonly kind: ProviderKind;
  readonly clearance: Classification = 'restricted';

  constructor(
    readonly name: string,
    kind: ProviderKind,
    private readonly reason: string,
  ) {
    this.kind = kind;
  }

  complete(): Promise<ChatResponse> {
    return Promise.reject(
      new OaxError(
        'provider_unavailable',
        `provider "${this.name}" is unavailable: ${this.reason}`,
      ),
    );
  }
}
