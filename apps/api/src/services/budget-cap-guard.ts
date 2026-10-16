import { pathIds } from '@openagentix/core';
import { and, count, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { HttpError } from '../errors.js';

/**
 * Budgets are per node until W13-4, so a node below a node with a monthly cap on it or on an
 * ancestor would spend outside that cap. A tenant admin therefore cannot create a child below such
 * a node, or move a node there (`403 budget_capped`): a platform operator does it (and may cap it).
 * `parent` is the node the new child hangs from; its own cap counts.
 */
export async function assertNoCapAbove(tx: Db, parent: { path: string }): Promise<void> {
  const chain = pathIds(parent.path);
  const [capped] = await tx
    .select({ n: count() })
    .from(tenants)
    .where(and(inArray(tenants.id, chain), isNotNull(tenants.monthlyBudgetMicros)));
  if (Number(capped?.n ?? 0) > 0)
    throw new HttpError(
      403,
      'budget_capped',
      'a tenant below a node with a monthly budget can only be created or moved there by a platform operator',
    );
}
