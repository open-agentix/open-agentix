import { randomUUID } from 'node:crypto';
import {
  GRANTABLE_ROLES,
  isGrantableRole,
  isRole,
  type AgentRoleGrant,
  type NodeRoleGrant,
  type RawGrants,
  type Role,
  type RoleNode,
  type TeamRoleGrant,
} from '@openagentix/core';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agentRoleBindings,
  agents,
  teamMembers,
  teams,
  tenantRoleBindings,
  tenants,
  users,
} from '../db/schema.js';
import { HttpError } from '../errors.js';

/**
 * Persistence of tenant role bindings (ADR 0014 section 4), slice S1.
 *
 * Three jobs only: the write-through mirror and its reconcile (#216) of `users.global_roles`, and loading the raw grants the
 * pure resolver (`effectiveAt` in `@openagentix/core`) needs. Nothing here decides a permission.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key of a mirrored role: `(user, home node, role)` without a use case. `trb_uq` makes this
 * the only slot a legacy role can occupy, whatever the shape of the row in it.
 *
 * Mirror-managed rows are the ones that are non-inheriting, non-expiring, without a use case, on
 * the user's home node. Semantics when a row with the same key exists in another shape (inheriting
 * or expiring; only possible once a grant API exists, S4):
 *
 * - **Adding** a role never overwrites or hides it: `ON CONFLICT DO NOTHING` keeps the row that is
 *   there, the change is reported as `blocked` (the role is held by a non-managed row), and the
 *   shadow check compares what the resolver really sees.
 * - **Removing** a role through `global_roles` revokes *every* binding of that key, whatever its
 *   shape (fail closed): a legacy role that is not listed must not stay effective through a row
 *   the mirror could not represent. Rows with a use case, on other nodes, or of a role that
 *   `global_roles` cannot hold (`pentest`) are never touched.
 */
const legacyKey = (user: { id: string; tenantId: string }) =>
  and(
    eq(tenantRoleBindings.userId, user.id),
    eq(tenantRoleBindings.tenantId, user.tenantId),
    sql`${tenantRoleBindings.useCase} is null`,
    inArray(tenantRoleBindings.role, [...GRANTABLE_ROLES]),
  );

export interface MirrorChange {
  added: number;
  removed: number;
  blocked: number;
}

/**
 * Makes the bindings of `user` on its home tenant equal to `roles` (the mirror of
 * `users.global_roles`): missing mirror rows are added, rows of roles that are not wanted are
 * deleted (see {@link legacyKey} for the exact semantics). Call it in the same transaction that
 * writes `global_roles`. Returns what it changed (`blocked` = wanted, but the key is held by a row
 * of another shape that was left as it is).
 *
 * `pentest` is refused: it needs an expiry, which `global_roles` cannot express.
 */
export async function mirrorGlobalRoles(
  db: Db,
  user: { id: string; tenantId: string },
  roles: readonly Role[],
  grantedBy?: string | null,
): Promise<MirrorChange> {
  const wanted = [...new Set(roles)];
  const refused = wanted.find((r) => !isGrantableRole(r));
  if (refused)
    throw new HttpError(422, 'validation_failed', `role ${refused} cannot be granted globally`);
  const removed = await db
    .delete(tenantRoleBindings)
    .where(
      wanted.length
        ? and(legacyKey(user), notInArray(tenantRoleBindings.role, wanted))
        : legacyKey(user),
    )
    .returning({ role: tenantRoleBindings.role });
  if (wanted.length === 0) return { added: 0, removed: removed.length, blocked: 0 };
  // `granted_by` is informational and a foreign key: only a real user id is recorded (system
  // actors such as the demo seed have none).
  const by =
    grantedBy && UUID.test(grantedBy)
      ? sql<string | null>`(select id from users where id = ${grantedBy})`
      : null;
  const inserted = await db
    .insert(tenantRoleBindings)
    .values(
      wanted.map((role) => ({
        id: randomUUID(),
        userId: user.id,
        tenantId: user.tenantId,
        role,
        inherit: false,
        grantedBy: by,
      })),
    )
    .onConflictDoNothing()
    .returning({ role: tenantRoleBindings.role });
  const present = await db
    .select({
      role: tenantRoleBindings.role,
      inherit: tenantRoleBindings.inherit,
      expiresAt: tenantRoleBindings.expiresAt,
    })
    .from(tenantRoleBindings)
    .where(legacyKey(user));
  const blocked = present.filter(
    (b) => (b.inherit || b.expiresAt !== null) && wanted.includes(b.role as Role),
  ).length;
  return { added: inserted.length, removed: removed.length, blocked };
}

/**
 * The authz epoch of the organisation a tenant belongs to (ADR 0014 section 6.1; bumped by the
 * database triggers of migration 0021 and the application). `undefined` when the tenant does not
 * exist. Read **before** the grants it guards: an entry built from an epoch read first can only be
 * rejected too early, never accepted too late.
 */
export async function loadAuthzEpoch(
  db: Db,
  tenantId: string,
): Promise<{ rootId: string; epoch: number } | undefined> {
  const res = (await db.execute(sql`
    select r.id as root_id, r.authz_epoch::text as epoch
    from ${tenants} t join ${tenants} r on r.id = t.root_id
    where t.id = ${tenantId}
  `)) as unknown as { rows: { root_id: string; epoch: string }[] };
  const row = res.rows[0];
  if (!row) return undefined;
  const epoch = Number(row.epoch);
  return Number.isSafeInteger(epoch) ? { rootId: String(row.root_id), epoch } : undefined;
}

/** The current epoch of one organisation root: the cheap per-request check of a cached principal. */
export async function currentAuthzEpoch(db: Db, rootId: string): Promise<number | undefined> {
  const res = (await db.execute(
    sql`select authz_epoch::text as epoch from ${tenants} where id = ${rootId}`,
  )) as unknown as { rows: { epoch: string }[] };
  const row = res.rows[0];
  if (!row) return undefined;
  const epoch = Number(row.epoch);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

/** What the resolver needs for one user, plus the placement of the user's home node. */
export interface LoadedGrants {
  raw: RawGrants;
  home: RoleNode;
}

/**
 * Loads every grant of `user` inside its home organisation, each tagged with the node it belongs
 * to (ADR 0014 section 3.1). `undefined` when the home tenant does not exist. Grants outside the
 * home organisation are never loaded.
 *
 * **One statement, one connection, one snapshot** (#217): the node row and the three grant lists
 * come back from a single query, so a principal build holds at most one pool connection and sees
 * the home node and the grants as of the same instant. Expiries travel as epoch milliseconds
 * (rounded down, so a binding can only end early, never late) and are revived into real `Date`s;
 * a value that is not a finite number drops that binding (fail closed).
 */
export async function loadRawGrants(
  db: Db,
  user: { id: string; tenantId: string; platformAdmin: boolean },
): Promise<LoadedGrants | undefined> {
  const orgNodes = (home: ReturnType<typeof sql>) =>
    sql`select ${tenants.id} from ${tenants} where ${tenants.rootId} = ${home}`;
  const res = (await db.execute(sql`
    select t.id, t.root_id, t.path,
      coalesce((
        select json_agg(json_build_object(
          'tenantId', ${tenantRoleBindings.tenantId},
          'role', ${tenantRoleBindings.role},
          'useCase', ${tenantRoleBindings.useCase},
          'inherit', ${tenantRoleBindings.inherit},
          'expiresMs', floor(extract(epoch from ${tenantRoleBindings.expiresAt}) * 1000)))
        from ${tenantRoleBindings}
        where ${tenantRoleBindings.userId} = ${user.id}
          and ${tenantRoleBindings.tenantId} in (${orgNodes(sql`t.root_id`)})
      ), '[]'::json) as nodes,
      coalesce((
        select json_agg(json_build_object(
          'tenantId', ${teams.tenantId}, 'teamId', ${teamMembers.teamId}, 'role', ${teamMembers.role}))
        from ${teamMembers} join ${teams} on ${teams.id} = ${teamMembers.teamId}
        where ${teamMembers.userId} = ${user.id}
          and ${teams.tenantId} in (${orgNodes(sql`t.root_id`)})
      ), '[]'::json) as team_rows,
      coalesce((
        select json_agg(json_build_object(
          'tenantId', ${agents.tenantId}, 'agentId', ${agentRoleBindings.agentId},
          'teamId', ${agents.teamId}, 'role', ${agentRoleBindings.role}))
        from ${agentRoleBindings} join ${agents} on ${agents.id} = ${agentRoleBindings.agentId}
        where ${agentRoleBindings.userId} = ${user.id}
          and ${agents.tenantId} in (${orgNodes(sql`t.root_id`)})
      ), '[]'::json) as agent_rows
    from ${tenants} t
    where t.id = ${user.tenantId}
  `)) as unknown as { rows: Record<string, unknown>[] };
  const row = res.rows[0];
  if (!row) return undefined;
  const json = (v: unknown): unknown[] => {
    const parsed = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return Array.isArray(parsed) ? parsed : [];
  };
  type NodeRow = {
    tenantId: string;
    role: string;
    useCase: string | null;
    inherit: boolean;
    expiresMs: number | string | null;
  };
  type TeamRow = { tenantId: string; teamId: string; role: string };
  type AgentRow = { tenantId: string; agentId: string; teamId: string | null; role: string };
  // Unknown role strings are dropped here (fail closed); `pentest` is not grantable yet, so it is
  // dropped from the legacy team and agent tables too.
  const nodeBindings: NodeRoleGrant[] = [];
  for (const r of json(row.nodes) as NodeRow[]) {
    if (!isRole(r.role)) continue;
    let expiresAt: Date | null = null;
    if (r.expiresMs !== null && r.expiresMs !== undefined) {
      const ms = Number(r.expiresMs);
      expiresAt = new Date(ms);
      if (!Number.isFinite(ms) || !Number.isFinite(expiresAt.getTime())) continue;
    }
    nodeBindings.push({
      tenantId: r.tenantId,
      role: r.role as Role,
      useCase: r.useCase,
      inherit: r.inherit,
      expiresAt,
    });
  }
  const teamBindings: TeamRoleGrant[] = (json(row.team_rows) as TeamRow[])
    .filter((r) => isGrantableRole(r.role))
    .map((r) => ({ tenantId: r.tenantId, teamId: r.teamId, role: r.role as Role }));
  const agentBindings: AgentRoleGrant[] = (json(row.agent_rows) as AgentRow[])
    .filter((r) => isGrantableRole(r.role))
    .map((r) => ({
      tenantId: r.tenantId,
      agentId: r.agentId,
      teamId: r.teamId,
      role: r.role as Role,
    }));
  const id = String(row.id);
  const rootId = String(row.root_id);
  return {
    raw: {
      userId: user.id,
      homeTenantId: id,
      homeRootId: rootId,
      platformAdmin: user.platformAdmin,
      nodeBindings,
      teamBindings,
      agentBindings,
    },
    home: { id, rootId, path: String(row.path) },
  };
}

// ---------------------------------------------------------------- reconcile (#216)

export interface ReconcileResult {
  userId: string;
  added: number;
  removed: number;
  /** Wanted roles whose key is held by a row of another shape (kept as it is; see legacyKey). */
  blocked: number;
}

/**
 * Recomputes the mirror of one user from `users.global_roles` and repairs it in both directions,
 * in one transaction. The user row is locked (`FOR NO KEY UPDATE`) first, in the same order every
 * writer of `global_roles` uses (user row, then bindings), so a concurrent `PATCH` serialises with
 * it instead of racing; the same triggers (`trb_same_org`) apply as for any other write. Returns
 * `undefined` for a user that no longer exists. Idempotent: a second call changes nothing.
 *
 * It repairs exactly what {@link mirrorGlobalRoles} manages (see {@link legacyKey}); inheriting,
 * expiring, use-case and other-node bindings, and `pentest`, are never touched.
 */
export async function reconcileUserBindings(
  db: Db,
  userId: string,
): Promise<ReconcileResult | undefined> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, tenantId: users.tenantId, globalRoles: users.globalRoles })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!user) return undefined;
    // Roles the application ignores (anything outside the six grantable ones) are ignored here too,
    // exactly like the backfill of migration 0018.
    const wanted = [...new Set(user.globalRoles)].filter(isGrantableRole) as Role[];
    const change = await mirrorGlobalRoles(
      tx as unknown as Db,
      { id: user.id, tenantId: user.tenantId },
      wanted,
    );
    return { userId, ...change };
  });
}

/** Users whose mirror differs from `global_roles`, after `afterId`, in id order (a cheap probe). */
export async function findDriftedUsers(db: Db, afterId: string, limit: number): Promise<string[]> {
  const roles = sql.join(
    GRANTABLE_ROLES.map((r) => sql`${r}`),
    sql`, `,
  );
  const res = (await db.execute(sql`
    select u.id from ${users} u
    where u.id > ${afterId}::uuid
      and (
        exists (
          select 1 from unnest(u.global_roles) as g(role)
          where g.role in (${roles})
            and not exists (
              select 1 from ${tenantRoleBindings} b
              where b.user_id = u.id and b.tenant_id = u.tenant_id and b.role = g.role
                and b.use_case is null)
        )
        or exists (
          select 1 from ${tenantRoleBindings} b
          where b.user_id = u.id and b.tenant_id = u.tenant_id and b.use_case is null
            and b.role in (${roles}) and not (b.role = any(u.global_roles))
        )
      )
    order by u.id limit ${limit}
  `)) as unknown as { rows: { id: string }[] };
  return res.rows.map((r) => r.id);
}

export interface ReconcileSummary {
  users: number;
  added: number;
  removed: number;
  blocked: number;
  /** User ids that were repaired (or, with `dryRun`, would be). */
  fixed: string[];
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Reconciles every user whose mirror drifted: probes in id order, repairs each in its own
 * transaction (`reconcileUserBindings`), never holds more than one connection. `dryRun` only
 * reports who would be repaired.
 */
export async function reconcileAllBindings(
  db: Db,
  opts: { batchSize?: number; dryRun?: boolean; onResult?: (r: ReconcileResult) => void } = {},
): Promise<ReconcileSummary> {
  const batch = opts.batchSize ?? 200;
  const out: ReconcileSummary = { users: 0, added: 0, removed: 0, blocked: 0, fixed: [] };
  let after = NIL_UUID;
  for (;;) {
    const ids = await findDriftedUsers(db, after, batch);
    if (ids.length === 0) break;
    for (const id of ids) {
      after = id;
      if (opts.dryRun) {
        out.users++;
        out.fixed.push(id);
        continue;
      }
      const r = await reconcileUserBindings(db, id);
      if (!r) continue;
      out.users++;
      out.added += r.added;
      out.removed += r.removed;
      out.blocked += r.blocked;
      if (r.added || r.removed) out.fixed.push(id);
      opts.onResult?.(r);
    }
    if (ids.length < batch) break;
  }
  return out;
}
