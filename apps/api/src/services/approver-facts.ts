import {
  appliedAt,
  hasPermissionIn,
  isRole,
  type AppliedBinding,
  type ApproverActor,
  type ApproverAuth,
  type ApproverBinding,
  type ApproverFacts,
  type GrantChain,
  type Permission,
  type Principal,
  type RoleBinding,
} from '@openagentix/core';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { agents } from '../db/schema.js';
import {
  agentRoleBindings,
  teamMembers,
  teams,
  tenantRoleBindings,
  tenants,
  users,
} from '../db/schema.js';
import { GRANTING_ROLES, creatorChainOf, storedChainOf, type GrantRow } from './grant-chain.js';
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

/** How many hops of the grant chain are followed before the rest counts as unknown. */
export const MAX_GRANT_CHAIN_DEPTH = 6;

interface ChainSeed {
  userId: string | null;
  unknown: boolean;
  /** The chain stored on the row the seed comes from (#356); evaluated together with the live walk. */
  stored?: GrantChain | undefined;
}

/** The seed of a binding or membership row: its direct grantor and the chain stored on it. */
const seedOf = (r: GrantRow): ChainSeed => {
  const stored = storedChainOf(r);
  return { userId: r.grantedBy, unknown: stored.unknown, stored };
};

/**
 * Follows a grant transitively (rule A4, finding 1 of the S1 review). Starting from the seeds (the
 * grantor of a binding, or the creator of an account) it collects every user the grant depends on:
 * the grantor, the account that created the grantor, and whoever granted the grantor the roles that
 * allow granting (`users:write`), and so on. A contributor anywhere in that chain makes the grant
 * contributor-made: a contributor must not be able to launder an approver through a second account.
 * A link without a known grantor, or a chain longer than `maxDepth`, is reported as `unknown`.
 */
export async function followGrantChain(
  db: Db,
  seeds: readonly ChainSeed[],
  now: Date,
  maxDepth = MAX_GRANT_CHAIN_DEPTH,
): Promise<GrantChain> {
  const seen = new Set<string>();
  let unknown = false;
  let frontier: string[] = [];
  const add = (id: string | null) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      frontier.push(id);
    }
  };
  // A stored id joins the result without being walked again: the chain it comes from is transitive
  // already, and the live walk below adds whatever the current bindings show on top.
  const addStored = (ids: readonly string[]) => {
    for (const id of ids) seen.add(id);
  };
  for (const s of seeds) {
    if (s.unknown) unknown = true;
    add(s.userId);
    if (s.stored) addStored(s.stored.users);
  }
  for (let hop = 1; frontier.length > 0; hop++) {
    if (hop > maxDepth) {
      unknown = true;
      break;
    }
    const level = frontier;
    frontier = [];
    const accounts = await db
      .select({
        createdBy: users.createdBy,
        creatorUnknown: users.creatorUnknown,
        grantChain: users.grantChain,
      })
      .from(users)
      .where(inArray(users.id, level));
    for (const a of accounts) {
      add(a.createdBy);
      const c = creatorChainOf(a);
      addStored(c.users);
      if (c.unknown) unknown = true;
    }
    const grants = await db
      .select({
        grantedBy: tenantRoleBindings.grantedBy,
        grantorUnknown: tenantRoleBindings.grantorUnknown,
        grantChain: tenantRoleBindings.grantChain,
      })
      .from(tenantRoleBindings)
      .where(
        and(
          inArray(tenantRoleBindings.userId, level),
          inArray(tenantRoleBindings.role, GRANTING_ROLES),
          or(isNull(tenantRoleBindings.expiresAt), gt(tenantRoleBindings.expiresAt, now)),
        ),
      );
    for (const g of grants) {
      const c = storedChainOf(g);
      if (c.unknown) unknown = true;
      add(g.grantedBy);
      addStored(c.users);
    }
  }
  return { users: [...seen].sort(), unknown };
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
    creatorChain: { users: [], unknown: false },
  };
  const [user] = await db.select().from(users).where(eq(users.id, q.userId));
  if (!user || user.disabled) return empty;
  const creatorChain = await followGrantChain(
    db,
    [{ userId: user.createdBy, unknown: false, stored: creatorChainOf(user) }],
    q.now,
  );
  if (creatorChainOf(user).unknown) creatorChain.unknown = true;
  const base: ApproverFacts = { ...empty, identitySource: user.source, creatorChain };
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
        grantorUnknown: false,
        chain: { users: [], unknown: false },
      });
    } else if (b.source === 'team' && b.teamId) {
      const rows = await db
        .select({
          grantedBy: teamMembers.grantedBy,
          unknown: teamMembers.grantorUnknown,
          grantChain: teamMembers.grantChain,
        })
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
          grantorUnknown: r.unknown,
          chain: await followGrantChain(db, [seedOf({ ...r, grantorUnknown: r.unknown })], now),
        });
    } else if (b.source === 'agent' && b.agentId) {
      const rows = await db
        .select({
          grantedBy: agentRoleBindings.grantedBy,
          unknown: agentRoleBindings.grantorUnknown,
          grantChain: agentRoleBindings.grantChain,
        })
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
          grantorUnknown: r.unknown,
          chain: await followGrantChain(db, [seedOf({ ...r, grantorUnknown: r.unknown })], now),
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
          grantorUnknown: r.grantorUnknown,
          chain: await followGrantChain(db, [seedOf(r)], now),
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
