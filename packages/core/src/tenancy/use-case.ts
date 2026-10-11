/**
 * Use cases in the tenant model (ADR 0013 section 7.2, ADR 0014 section 3.3).
 *
 * A use case is the `labels.useCase` value of an agent definition inside a node. Its children are
 * the sub-use cases (the use case as a path prefix, `/` as the separator, matched per segment: `support`
 * covers `support` and `support/billing`, never `supported`) and the child nodes attached to it
 * (`tenants.use_case`, section 3.3). Everything here is pure.
 */

/** Longest use case in characters (same bound as `labels.useCase`). */
export const MAX_USE_CASE_CHARS = 200;

/**
 * The syntax of a use case that may scope a role binding or be attached to a node: one or more
 * segments separated by a single `/`, each starting with a letter or digit and continuing with
 * letters, digits, `.`, `_` or `-`. No whitespace, no leading, trailing or doubled `/`, no
 * wildcard characters, so the value can be compared and pattern-matched without escaping rules.
 */
export const USE_CASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function isValidUseCase(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_USE_CASE_CHARS && USE_CASE_PATTERN.test(value)
  );
}

/**
 * Whether the use case `scope` covers a resource labelled `value`: the use case itself or one of
 * its sub-use cases. A missing label is covered by nothing (a resource without a use case belongs
 * to the whole node, never to a use case), and an invalid `scope` covers nothing (fail closed).
 */
export function useCaseCovers(scope: string, value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value === '' || !isValidUseCase(scope)) return false;
  return value === scope || value.startsWith(`${scope}/`);
}

/**
 * The minimal list of scopes: duplicates and scopes that another scope of the list covers are
 * dropped. Invalid scopes are dropped too.
 */
export function minimalUseCases(scopes: Iterable<string>): string[] {
  const unique = [...new Set([...scopes].filter(isValidUseCase))].sort();
  return unique.filter((s) => !unique.some((o) => o !== s && useCaseCovers(o, s)));
}
