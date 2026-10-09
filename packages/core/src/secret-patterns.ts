/**
 * Credential-shaped strings, shared by the pull-request secret scan (`apps/worker`, fail closed on a
 * hit) and the model-context guard (`context-guard.ts`, replace the match). One list, so a pattern
 * added for one stage protects the other.
 *
 * Every pattern is linear on adversarial input: no unbounded repetition sits in front of a literal
 * anchor, and the `ContextGuard` time/size tests run each pattern against hostile 256 KiB inputs.
 */
// Every repetition before a literal anchor is bounded: an unbounded `[a-z0-9.-]*` in front of `://`
// made the scan quadratic (64 KiB of `a.a.a.` blocked the event loop for seconds).
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{16,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['slack-webhook', /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/],
  ['openai-style-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ['run-token', /\boaxrt\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,})?/],
  ['model-token', /\boaxmt\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,})?/],
  ['platform-token', /\boax_[A-Za-z0-9]{8,}_[A-Za-z0-9_-]{16,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  // The lookbehind (not `\b`) keeps a match from starting inside a run of base64url characters:
  // with `\b`, every `eyJ` after a `-` was a new start that rescanned the whole run (`eyJ-` x 64 Ki
  // took 8 s, 512 KiB over 3 minutes).
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['authorization-header', /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['url-credentials', /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:[^\s/@]{3,256}@/i],
  [
    'env-secret-assignment',
    /\b[A-Z][A-Z0-9_]{0,63}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]{0,63}\s{0,8}[=:]\s{0,8}["']?[^\s"']{12,}/,
  ],
  [
    'secret-assignment',
    /\b(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{20,}["']/i,
  ],
];
