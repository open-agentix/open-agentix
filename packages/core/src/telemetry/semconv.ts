/**
 * The OpenTelemetry GenAI semantic conventions this code base is written against (ADR 0015
 * section 1). All GenAI documents of that repository have status "Development": names and shapes
 * may still change, so the version is pinned in exactly one place. Following upstream is a
 * deliberate pull request with updated golden tests and a `Changed` changelog entry; there is no
 * dual emission of old and new names.
 */
export const GENAI_SEMCONV_PIN = {
  repository: 'open-telemetry/semantic-conventions-genai',
  commit: '6fd0d76',
  coreVersion: '1.44.0',
} as const;
