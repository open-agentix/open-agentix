import { ROLE_PERMISSIONS, ROLES, type GrantChain } from '@openagentix/core';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tenantRoleBindings, users } from '../db/schema.js';

/**
 * The stored grant chain (ADR 0017 rule A4, #356). A binding, a membership or an account carries the
 * ids of everybody it depended on when it was made, so that a link which is revoked, expires or is
 * deleted afterwards cannot launder the approver. The chain is computed by the writer, inside the
 * transaction that holds the binding lock, with {@link chainForGrant}; it is evaluated together with
 * the live chain (`followGrantChain`), never instead of it.
 *
 * Encoding (no sentinel values):
 * - `granted_by` null, flag false, chain null: nobody granted it (identity provider, bootstrap).
 * - `granted_by` set, chain null: the chain was never recorded: **unknown**, fail closed.
 * - flag true: unknown, whatever else the row says.
 */

/** Roles whose holders may grant roles to others (`users:write`, the authority of ADR 0014 section 7). */
export const GRANTING_ROLES = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('users:write'));

/** A chain longer than this is stored as unknown rather than growing without bound. */
export const MAX_STORED_CHAIN = 200;

export interface GrantRow {
  grantedBy: string | null;
  grantorUnknown: boolean;
  grantChain: readonly string[] | null;
}

export interface AccountRow {
  createdBy: string | null;
  creatorUnknown: boolean;
  grantChain: readonly string[] | null;
}

/** What a binding row says about its own grant chain (the stored part, no database access). */
export function storedChainOf(r: GrantRow): GrantChain {
  const users = new Set<string>(r.grantChain ?? []);
  if (r.grantedBy) users.add(r.grantedBy);
  return {
    users: [...users].sort(),
    unknown: r.grantorUnknown || (r.grantedBy !== null && r.grantChain === null),
  };
}

/** What an account row says about the chain of its creation. */
export function creatorChainOf(r: AccountRow): GrantChain {
  const users = new Set<string>(r.grantChain ?? []);
  if (r.createdBy) users.add(r.createdBy);
  return {
    users: [...users].sort(),
    unknown: r.creatorUnknown || (r.createdBy !== null && r.grantChain === null),
  };
}

const merge = (a: GrantChain, b: GrantChain): GrantChain => ({
  users: [...new Set([...a.users, ...b.users])].sort(),
  unknown: a.unknown || b.unknown,
});

/**
 * The chain of an act of `grantorId` (granting a role, adding a member, creating an account): the
 * grantor, the stored chain of the account that made the grantor, and the stored chains of the
 * grantor's own bindings that carry the right to grant. Call it in the transaction that holds the
 * binding lock. `null` = the chain cannot be established (a link is unknown, or it is too long):
 * store it as no chain, which reads as unknown.
 *
 * `undefined` is returned when `grantorId` is not an account (a system actor such as the demo seed):
 * nobody granted it, the same as before the chain existed.
 */
export async function chainForGrant(
  tx: Db,
  grantorId: string | null | undefined,
  now: Date,
): Promise<string[] | null | undefined> {
  if (!grantorId) return undefined;
  const [g] = await tx
    .select({
      id: users.id,
      createdBy: users.createdBy,
      creatorUnknown: users.creatorUnknown,
      grantChain: users.grantChain,
    })
    .from(users)
    .where(eq(users.id, grantorId));
  if (!g) return undefined;
  let chain: GrantChain = merge({ users: [g.id], unknown: false }, creatorChainOf(g));
  const bindings = await tx
    .select({
      grantedBy: tenantRoleBindings.grantedBy,
      grantorUnknown: tenantRoleBindings.grantorUnknown,
      grantChain: tenantRoleBindings.grantChain,
    })
    .from(tenantRoleBindings)
    .where(
      and(
        eq(tenantRoleBindings.userId, g.id),
        inArray(tenantRoleBindings.role, GRANTING_ROLES),
        or(isNull(tenantRoleBindings.expiresAt), gt(tenantRoleBindings.expiresAt, now)),
      ),
    );
  for (const b of bindings) chain = merge(chain, storedChainOf(b));
  if (chain.unknown || chain.users.length > MAX_STORED_CHAIN) return null;
  return [...chain.users];
}

/**
 * The chain after a binding was made wider by `actor`: everything the row already depended on plus
 * everything the actor's act depends on. A row that is unknown stays unknown; a row nobody granted
 * simply takes the actor's chain.
 */
export function widenedChain(
  row: GrantRow,
  actorChain: string[] | null | undefined,
): string[] | null {
  if (actorChain === undefined) return row.grantChain === null ? null : [...row.grantChain];
  if (actorChain === null) return null;
  const old = storedChainOf(row);
  if (old.unknown) return null;
  const all = [...new Set([...old.users, ...actorChain])].sort();
  return all.length > MAX_STORED_CHAIN ? null : all;
}
