import { randomUUID } from 'node:crypto';
import {
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
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  agentRoleBindings,
  agents,
  teamMembers,
  teams,
  tenantRoleBindings,
  tenants,
} from '../db/schema.js';
import { HttpError } from '../errors.js';

/**
 * Persistence of tenant role bindings (ADR 0014 section 4), slice S1.
 *
 * Two jobs only: the write-through mirror of `users.global_roles`, and loading the raw grants the
 * pure resolver (`effectiveAt` in `@openagentix/core`) needs. Nothing here decides a permission.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Makes the non-inheriting, non-expiring, non-use-case bindings of `user` on its home tenant equal
 * to `roles` (the mirror of `users.global_roles`). Bindings of any other shape (inheriting,
 * expiring, use-case, other nodes) are never touched, so a future grant API and this mirror cannot
 * delete each other's rows. Call it in the same transaction that writes `global_roles`.
 *
 * `pentest` is refused: it needs an expiry, which `global_roles` cannot express.
 */
export async function mirrorGlobalRoles(
  db: Db,
  user: { id: string; tenantId: string },
  roles: readonly Role[],
  grantedBy?: string | null,
): Promise<void> {
  const wanted = [...new Set(roles)];
  const refused = wanted.find((r) => !isGrantableRole(r));
  if (refused)
    throw new HttpError(422, 'validation_failed', `role ${refused} cannot be granted globally`);
  const mirrorShape = and(
    eq(tenantRoleBindings.userId, user.id),
    eq(tenantRoleBindings.tenantId, user.tenantId),
    eq(tenantRoleBindings.inherit, false),
    sql`${tenantRoleBindings.useCase} is null`,
    sql`${tenantRoleBindings.expiresAt} is null`,
  );
  await db
    .delete(tenantRoleBindings)
    .where(
      wanted.length ? and(mirrorShape, notInArray(tenantRoleBindings.role, wanted)) : mirrorShape,
    );
  if (wanted.length === 0) return;
  // `granted_by` is informational and a foreign key: only a real user id is recorded (system
  // actors such as the demo seed have none).
  const by =
    grantedBy && UUID.test(grantedBy)
      ? sql<string | null>`(select id from users where id = ${grantedBy})`
      : null;
  await db
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
    .onConflictDoNothing();
}

/** What the resolver needs for one user, plus the placement of the user's home node. */
export interface LoadedGrants {
  raw: RawGrants;
  home: RoleNode;
}

/**
 * Loads every grant of `user` inside its home organisation, each tagged with the node it belongs
 * to (ADR 0014 section 3.1). `undefined` when the home tenant does not exist. Three small indexed
 * reads plus the node row; grants outside the home organisation are never loaded.
 */
export async function loadRawGrants(
  db: Db,
  user: { id: string; tenantId: string; platformAdmin: boolean },
): Promise<LoadedGrants | undefined> {
  const [home] = await db
    .select({ id: tenants.id, rootId: tenants.rootId, path: tenants.path })
    .from(tenants)
    .where(eq(tenants.id, user.tenantId));
  if (!home) return undefined;
  const inOrg = (tenantColumn: AnyPgColumn) =>
    inArray(
      tenantColumn,
      db.select({ id: tenants.id }).from(tenants).where(eq(tenants.rootId, home.rootId)),
    );
  const [nodeRows, teamRows, agentRows] = await Promise.all([
    db
      .select()
      .from(tenantRoleBindings)
      .where(and(eq(tenantRoleBindings.userId, user.id), inOrg(tenantRoleBindings.tenantId))),
    db
      .select({ tenantId: teams.tenantId, teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, user.id), inOrg(teams.tenantId))),
    db
      .select({
        tenantId: agents.tenantId,
        agentId: agentRoleBindings.agentId,
        teamId: agents.teamId,
        role: agentRoleBindings.role,
      })
      .from(agentRoleBindings)
      .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
      .where(and(eq(agentRoleBindings.userId, user.id), inOrg(agents.tenantId))),
  ]);
  // Unknown role strings are dropped here (fail closed); `pentest` is not grantable yet, so it is
  // dropped from the legacy team and agent tables too.
  const nodeBindings: NodeRoleGrant[] = nodeRows
    .filter((r) => isRole(r.role))
    .map((r) => ({
      tenantId: r.tenantId,
      role: r.role as Role,
      useCase: r.useCase,
      inherit: r.inherit,
      expiresAt: r.expiresAt,
    }));
  const teamBindings: TeamRoleGrant[] = teamRows
    .filter((r) => isGrantableRole(r.role))
    .map((r) => ({ tenantId: r.tenantId, teamId: r.teamId, role: r.role as Role }));
  const agentBindings: AgentRoleGrant[] = agentRows
    .filter((r) => isGrantableRole(r.role))
    .map((r) => ({
      tenantId: r.tenantId,
      agentId: r.agentId,
      teamId: r.teamId,
      role: r.role as Role,
    }));
  return {
    raw: {
      userId: user.id,
      homeTenantId: home.id,
      homeRootId: home.rootId,
      platformAdmin: user.platformAdmin,
      nodeBindings,
      teamBindings,
      agentBindings,
    },
    home: { id: home.id, rootId: home.rootId, path: home.path },
  };
}
