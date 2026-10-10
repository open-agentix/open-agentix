import { HttpError } from '../errors.js';
import type { ResolvedScope, SubtreeScopes, TenantRef } from '../services/subtree-scope.js';

/** Default and largest page of the lists that only page with `scope=subtree`. */
export const SUBTREE_DEFAULT_PAGE = 200;

/** `tenant` of the rows of a `scope=subtree` list: one lookup for the tenants of the whole page. */
export async function rowTenants(
  subtree: SubtreeScopes,
  scope: ResolvedScope,
  rows: readonly { tenantId: string }[],
): Promise<(row: { tenantId: string }) => TenantRef | undefined> {
  const refs = await subtree.refsFor(
    scope,
    rows.map((r) => r.tenantId),
  );
  return (row) => refs.get(row.tenantId);
}

/** `limit` and `cursor` belong to `scope=subtree`; the single-node lists are not paged. */
export function assertPagingNeedsSubtree(q: {
  scope?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}): void {
  if (q.scope !== 'subtree' && (q.limit !== undefined || q.cursor !== undefined))
    throw new HttpError(400, 'validation_failed', 'limit and cursor need scope=subtree');
}

/** Platform operators' `allTenants` and `scope=subtree` are two different ways to widen a list. */
export function assertNotBoth(q: { scope?: string | undefined; allTenants?: boolean | undefined }) {
  if (q.scope === 'subtree' && q.allTenants)
    throw new HttpError(
      400,
      'validation_failed',
      'allTenants cannot be combined with scope=subtree',
    );
}
