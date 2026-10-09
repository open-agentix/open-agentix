import type { HarnessKind } from '@openagentix/core';
import type { ProviderKind } from '../types.js';
import type { PassthroughSurface } from './requests.js';

/**
 * Which pass-through surface a harness can speak (ADR 0009 section 10). The proxy does not
 * translate between protocols, so the surface follows from the harness and the step's provider.
 */
export const HARNESS_SURFACES: Readonly<Record<HarnessKind, readonly PassthroughSurface[]>> = {
  // Claude Code only speaks the Anthropic Messages protocol.
  'claude-code': ['anthropic'],
  // OpenCode has providers for both protocols.
  opencode: ['anthropic', 'openai'],
};

/** The protocol a provider kind speaks upstream (the simulated provider synthesises either). */
export function surfaceOfProviderKind(kind: ProviderKind): PassthroughSurface {
  switch (kind) {
    case 'anthropic':
    case 'bedrock':
    case 'simulated':
      return 'anthropic';
    case 'openai':
    case 'ollama':
      return 'openai';
  }
}

/** The surface a harness has to use for a provider, or `null` when none fits (fail closed). */
export function harnessSurface(
  harness: HarnessKind,
  providerKind: ProviderKind,
): PassthroughSurface | null {
  const surface = surfaceOfProviderKind(providerKind);
  return HARNESS_SURFACES[harness].includes(surface) ? surface : null;
}
