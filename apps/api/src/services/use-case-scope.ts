import { useCaseScopes, type Permission, type Principal } from '@openagentix/core';
import { eq, like, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { escapeLike } from './agent-filters.js';

/**
 * Row filters for resources that carry a use case (ADR 0014 section 3.3, slice S8). One place
 * builds the SQL, so no service writes its own `LIKE` for a use case.
 *
 * A use case covers itself and its sub-use cases, matched per `/` segment: `support` covers
 * `support` and `support/billing`, never `supported`. A resource without a label (`NULL`) matches
 * no use case: it belongs to the whole node.
 */

/** `col` is one of `scopes` or below one of them. `false` for an empty list (fail closed). */
export function useCaseMatch(col: SQLWrapper, scopes: readonly string[]): SQL {
  if (scopes.length === 0) return sql`false`;
  const parts = scopes.flatMap((s) => [
    eq(col as never, s),
    like(col as never, `${escapeLike(s)}/%`),
  ]);
  return or(...parts) as SQL;
}

/**
 * The use cases the principal reads or writes `permission` for through use-case bindings, as a
 * minimal list; empty for a principal that holds it node-wide only. Services combine this with the
 * team and agent scope they already have: `node-wide OR team OR agent OR use case`.
 */
export function useCasesOf(principal: Principal, permission: Permission): string[] {
  return useCaseScopes(principal, permission);
}
