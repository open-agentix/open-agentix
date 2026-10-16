import {
  appliedAt,
  hasPermissionIn,
  isRole,
  type AppliedBinding,
  type ApproverActor,
  type ApproverAuth,
  type ApproverBinding,
  type ApproverFacts,
  type Permission,
  type Principal,
  type RoleBinding,
} from '@openagentix/core';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
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
import { loadRawGrants } from './role-bindings.js';

/**
 * What the approval rules (`checkApprover`, ADR 0017 section 5.1) need to know about one reviewer
 * and one agent, read from the database inside the caller's transaction. Never from a cached
 * principal: the grants of the reviewer are loaded again, with the resolver the request path uses
 * (`appliedAt`), and every binding that qualifies is traced back to its row, so that the rule A4
 * can see who granted it.
 *
 * The same function serves the live decision and the re-check of a stored one (a reviewer who is
 * not the caller), so there is exactly one implementation of "is this person an approver for this
 * agent right now".
 */

type AgentRow = typeof agents.$inferSelect;

export interface ApproverQuery {
  userId: string;
  agent: Pick<AgentRow, 'id' | 'tenantId' | 'teamId' | 'useCase'>;
  actor: ApproverActor;
  auth: ApproverAuth;
  now: Date;
  /** API token scopes of the live caller; a re-check of a stored decision passes none. */
  scopes?: readonly Permission[] | undefined;
}

const has = (bindings: readonly AppliedBinding[], permission: Permission, ref: object) =>
  hasPermissionIn(pseudoPrincipal(bindings), permission, ref);

/** A principal that carries only these bindings (the resolver's output) for the permission helpers. */
function pseudoPrincipal(bindings: readonly AppliedBinding[]): Principal {
  return {
    kind: 'user',
    userId: '',
    tenantId: '',
    displayName: '',
    platformAdmin: false,
    bindings: bindings as unknown as RoleBinding[],
  };
}

export async function loadApproverFacts(db: Db, q: ApproverQuery): Promise<ApproverFacts> {
  const empty: ApproverFacts = {
    userId: q.userId,
    actor: q.actor,
    auth: q.auth,
    identitySource: '',
    canRead: false,
    bindings: [],
    inAgentTeam: false,
  };
  const [user] = await db.select().from(users).where(eq(users.id, q.userId));
  if (!user || user.disabled) return empty;
  const base: ApproverFacts = { ...empty, identitySource: user.source };
  const [node] = await db.select().from(tenants).where(eq(tenants.id, q.agent.tenantId));
  if (!node) return base;
  const loaded = await loadRawGrants(db, {
    id: user.id,
    tenantId: user.tenantId,
    platformAdmin: user.platformAdmin,
  });
  if (!loaded) return base;
  const ref = { teamId: q.agent.teamId, agentId: q.agent.id, useCase: q.agent.useCase };
  const scoped = (p: Permission) => !q.scopes || q.scopes.includes(p);
  const now = q.now;
  const resolver = { now, implicitPlatformAdmin: false } as const;

  const sameOrg = node.rootId === loaded.home.rootId;
  // A platform operator acting in another organisation keeps the roles of the home tenant (ADR 0013
  // 7.1, as in the request path): those global roles qualify, with the operator flag as the source
  // and nobody as the grantor.
  const applied = sameOrg
    ? appliedAt(loaded.raw, { id: node.id, rootId: node.rootId, path: node.path }, resolver)
    : user.platformAdmin
      ? appliedAt(loaded.raw, loaded.home, resolver)
          .filter((b) => b.teamId === null && !b.agentId && b.useCase === null)
          .map((b) => ({ ...b, source: 'platform' as const }))
      : [];
  const canRead = scoped('agents:read') && has(applied, 'agents:read', ref);
  const approvers = scoped('agents:approve')
    ? applied.filter(
        (b) =>
          isRole(b.role) &&
          b.permissions.includes('agents:approve') &&
          has([b], 'agents:approve', ref),
      )
    : [];

  const bindings: ApproverBinding[] = [];
  for (const b of approvers) {
    if (b.source === 'platform') {
      bindings.push({
        id: `platform:${b.role}`,
        role: b.role,
        source: 'platform',
        grantedBy: null,
      });
    } else if (b.source === 'team' && b.teamId) {
      const rows = await db
        .select({ grantedBy: teamMembers.grantedBy })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(
          and(
            eq(teamMembers.userId, user.id),
            eq(teamMembers.teamId, b.teamId),
            eq(teamMembers.role, b.role),
            eq(teams.tenantId, node.id),
          ),
        );
      for (const r of rows)
        bindings.push({
          id: `team:${b.teamId}:${b.role}`,
          role: b.role,
          source: 'team',
          grantedBy: r.grantedBy,
        });
    } else if (b.source === 'agent' && b.agentId) {
      const rows = await db
        .select({ grantedBy: agentRoleBindings.grantedBy })
        .from(agentRoleBindings)
        .where(
          and(
            eq(agentRoleBindings.userId, user.id),
            eq(agentRoleBindings.agentId, b.agentId),
            eq(agentRoleBindings.role, b.role),
          ),
        );
      for (const r of rows)
        bindings.push({
          id: `agent:${b.agentId}:${b.role}`,
          role: b.role,
          source: 'agent',
          grantedBy: r.grantedBy,
        });
    } else {
      // A node binding: direct, inherited, or (use-case binding that reaches an attached node)
      // attached. Only rows that have not expired count, whatever else the resolver saw.
      const rows = await db
        .select()
        .from(tenantRoleBindings)
        .where(
          and(
            eq(tenantRoleBindings.userId, user.id),
            eq(tenantRoleBindings.tenantId, b.tenantId),
            eq(tenantRoleBindings.role, b.role),
            eq(tenantRoleBindings.inherit, b.inherit),
            b.source === 'attached' ? undefined : isNull(tenantRoleBindings.useCase),
            or(isNull(tenantRoleBindings.expiresAt), gt(tenantRoleBindings.expiresAt, now)),
          ),
        );
      for (const r of rows)
        bindings.push({
          id: r.id,
          role: b.role,
          source:
            r.source === 'grant' ? 'grant' : r.source === 'directory' ? 'directory' : 'mirror',
          grantedBy: r.grantedBy,
        });
    }
  }
  const inAgentTeam = applied.some(
    (b) =>
      (b.source === 'team' && q.agent.teamId !== null && b.teamId === q.agent.teamId) ||
      (b.source === 'agent' && b.agentId === q.agent.id),
  );
  return { ...base, canRead, bindings, inAgentTeam };
}
