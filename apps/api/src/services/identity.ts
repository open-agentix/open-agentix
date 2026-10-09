import { randomUUID } from 'node:crypto';
import {
  OaxError,
  effectivePermissions,
  homeTenantOf,
  isRole,
  type Permission,
  type Principal,
  type Role,
  type RoleBinding,
  type TenantActor,
} from '@openagentix/core';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { ldapAuthenticate } from '../auth/ldap.js';
import { openidClient, pkceChallenge, randomOidcValues, type OidcClient } from '../auth/oidc.js';
import { newToken, parseToken, secretMatches } from '../auth/tokens.js';
import { cached } from '../cache.js';
import { mapGroupsToBindings, type MappedBinding } from '../config.js';
import type { AppContext } from '../context.js';
import {
  DEFAULT_TENANT_ID,
  agentRoleBindings,
  agents,
  apiTokens,
  oidcStates,
  teamMembers,
  teams,
  users,
} from '../db/schema.js';
import type { tenants } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import { TenantAccess } from './tenant-access.js';

export type UserRow = typeof users.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;

export type TenantRow = typeof tenants.$inferSelect;

export interface PublicUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  source: string;
  globalRoles: string[];
  disabled: boolean;
  teams: { teamId: string; role: string }[];
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface TokenInfo {
  id: string;
  name: string;
  kind: string;
  scopes: string[] | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface IssuedToken extends TokenInfo {
  token: string;
}

interface CachedPrincipal {
  principal: Principal;
  /** Epoch ms when the underlying token expires. */
  exp: number;
}

const unauthenticated = (msg = 'authentication required') =>
  new HttpError(401, 'unauthenticated', msg);

/** Users, teams, sessions, API tokens, local/LDAP/OIDC login and principal resolution. */
export class IdentityService {
  private oidc: OidcClient | null;
  private readonly access: TenantAccess;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.access = new TenantAccess(ctx);
    this.oidc =
      ctx.oidcClient ?? (ctx.config.auth.oidc ? openidClient(ctx.config.auth.oidc) : null);
  }

  /** Creates the local bootstrap admin when the user table is empty. */
  async ensureBootstrapAdmin(): Promise<boolean> {
    const admin = this.ctx.config.auth.bootstrapAdmin;
    if (!admin) return false;
    const [{ count } = { count: 0 }] = await this.ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    if (count > 0) return false;
    await this.ctx.db.insert(users).values({
      id: randomUUID(),
      email: admin.email.toLowerCase(),
      displayName: 'Administrator',
      passwordHash: await hashPassword(admin.password),
      source: 'local',
      globalRoles: ['admin'],
      tenantId: DEFAULT_TENANT_ID,
      platformAdmin: true,
    });
    await this.audit.append({
      actor: 'system',
      tenantId: DEFAULT_TENANT_ID,
      action: 'user.bootstrap',
      target: admin.email.toLowerCase(),
    });
    return true;
  }

  // ---------- principals ----------

  async bindingsFor(user: UserRow): Promise<RoleBinding[]> {
    // Memberships and agent bindings only count inside the user's own tenant.
    const memberships = await this.ctx.db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, user.id), eq(teams.tenantId, user.tenantId)));
    const bindings: RoleBinding[] = user.globalRoles
      .filter(isRole)
      .map((role) => ({ role, teamId: null }));
    for (const m of memberships)
      if (isRole(m.role)) bindings.push({ role: m.role, teamId: m.teamId });
    const agentBindings = await this.ctx.db
      .select({
        role: agentRoleBindings.role,
        agentId: agentRoleBindings.agentId,
        teamId: agents.teamId,
      })
      .from(agentRoleBindings)
      .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
      .where(and(eq(agentRoleBindings.userId, user.id), eq(agents.tenantId, user.tenantId)));
    for (const b of agentBindings)
      if (isRole(b.role)) bindings.push({ role: b.role, teamId: b.teamId, agentId: b.agentId });
    return bindings;
  }

  /** Users with a role on exactly one agent (resource-scoped bindings). */
  async agentMembers(
    actor: TenantActor,
    agentId: string,
  ): Promise<{ userId: string; email: string; displayName: string; role: string }[]> {
    await this.assertAgentInTenant(actor, agentId);
    return this.ctx.db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: agentRoleBindings.role,
      })
      .from(agentRoleBindings)
      .innerJoin(users, eq(users.id, agentRoleBindings.userId))
      .where(and(eq(agentRoleBindings.agentId, agentId), eq(users.tenantId, actor.tenantId)))
      .orderBy(users.email);
  }

  private async assertAgentInTenant(actor: TenantActor, agentId: string): Promise<void> {
    const [a] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, actor.tenantId)));
    if (!a) throw notFound('agent');
  }

  /** Every user id must belong to the actor's tenant (otherwise: 404, nothing is revealed). */
  private async assertUsersInTenant(actor: TenantActor, userIds: readonly string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const rows = await this.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, unique), eq(users.tenantId, actor.tenantId)));
    if (rows.length !== unique.length) throw notFound('user');
  }

  async setAgentMembers(
    actor: TenantActor,
    agentId: string,
    members: { userId: string; role: Role }[],
  ): Promise<void> {
    await this.assertAgentInTenant(actor, agentId);
    await this.assertUsersInTenant(
      actor,
      members.map((m) => m.userId),
    );
    const previous = await this.ctx.db
      .select({ userId: agentRoleBindings.userId })
      .from(agentRoleBindings)
      .where(eq(agentRoleBindings.agentId, agentId));
    await this.ctx.db.transaction(async (tx) => {
      await tx.delete(agentRoleBindings).where(eq(agentRoleBindings.agentId, agentId));
      if (members.length)
        await tx
          .insert(agentRoleBindings)
          .values(members.map((m) => ({ agentId, userId: m.userId, role: m.role })))
          .onConflictDoNothing();
    });
    await Promise.all(
      [...new Set([...previous.map((p) => p.userId), ...members.map((m) => m.userId)])].map((u) =>
        this.invalidateUserTokens(u),
      ),
    );
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'agent.members.set',
      target: agentId,
      payload: { members },
    });
  }

  /** Principal of a user (e.g. for stream tokens), optionally restricted to scopes. */
  async principalForUser(userId: string, scopes?: Permission[]): Promise<Principal> {
    const [user] = await this.ctx.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.disabled) throw unauthenticated('user not found or disabled');
    return {
      kind: 'user',
      userId: user.id,
      tenantId: user.tenantId,
      platformAdmin: user.platformAdmin,
      displayName: user.displayName,
      bindings: await this.bindingsFor(user),
      scopes,
    };
  }

  /**
   * Acting inside another node of the tenant tree (`X-OAX-Tenant: <id | slug | slug path>`,
   * ADR 0013 7.4): platform operators may act in every node, tenant admins in their own node and
   * everything below it, everybody else only in their own node. A node outside that reach
   * (sibling, ancestor, another organisation) answers 404, indistinguishable from an unknown one.
   * The roles stay those of the home tenant; the principal remembers it as `homeTenantId`.
   */
  async actingIn(principal: Principal, tenant: string): Promise<Principal> {
    const row = await this.access.resolveVisible(principal, tenant);
    if (!row) throw notFound('tenant');
    if (row.id === principal.tenantId) return principal;
    return { ...principal, tenantId: row.id, homeTenantId: homeTenantOf(principal) };
  }

  /** Resolves a bearer token to a principal; cached for min(auth cache TTL, token lifetime). */
  async authenticate(bearer: string): Promise<Principal> {
    const parsed = parseToken(bearer);
    if (!parsed) throw unauthenticated('invalid token');
    const key = `auth:${parsed.id}`;
    const now = this.ctx.now().getTime();
    const hit = await this.ctx.cache.get<CachedPrincipal & { secretHash: string }>(key);
    if (hit && hit.exp > now) {
      if (!secretMatches(parsed.secret, hit.secretHash)) throw unauthenticated('invalid token');
      return hit.principal;
    }
    const [row] = await this.ctx.db
      .select({ token: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.id, parsed.id));
    if (!row || row.token.revokedAt || row.token.expiresAt.getTime() <= now || row.user.disabled)
      throw unauthenticated('invalid token');
    if (!secretMatches(parsed.secret, row.token.secretHash)) throw unauthenticated('invalid token');
    const principal: Principal = {
      kind: row.token.kind === 'session' ? 'user' : 'token',
      userId: row.user.id,
      tenantId: row.user.tenantId,
      platformAdmin: row.user.platformAdmin,
      displayName: row.user.displayName,
      bindings: await this.bindingsFor(row.user),
      scopes: (row.token.scopes as Permission[] | null) ?? undefined,
    };
    const ttl = Math.min(
      this.ctx.config.auth.cacheTtlSeconds * 1000,
      row.token.expiresAt.getTime() - now,
    );
    await this.ctx.cache.set(
      key,
      { principal, exp: row.token.expiresAt.getTime(), secretHash: row.token.secretHash },
      ttl,
    );
    void this.ctx.db
      .update(apiTokens)
      .set({ lastUsedAt: this.ctx.now() })
      .where(eq(apiTokens.id, parsed.id))
      .catch(() => undefined);
    return principal;
  }

  async issueToken(
    userId: string,
    opts: {
      name: string;
      kind: 'session' | 'api';
      ttlSeconds: number;
      scopes?: Permission[] | null;
    },
  ): Promise<IssuedToken> {
    const t = newToken();
    const expiresAt = new Date(this.ctx.now().getTime() + opts.ttlSeconds * 1000);
    const [row] = await this.ctx.db
      .insert(apiTokens)
      .values({
        id: t.id,
        userId,
        name: opts.name,
        kind: opts.kind,
        secretHash: t.secretHash,
        scopes: opts.scopes ?? null,
        expiresAt,
      })
      .returning();
    return { ...toTokenInfo(row!), token: t.token };
  }

  /** API token for the current principal; scopes are capped to what the principal may do. */
  async createApiToken(
    principal: Principal,
    name: string,
    scopes: Permission[] | undefined,
    expiresInDays: number,
  ): Promise<IssuedToken> {
    const allowed = effectivePermissions(principal);
    const requested = scopes ?? allowed;
    const excess = requested.filter((s) => !allowed.includes(s));
    if (excess.length) throw forbidden(`cannot grant scopes you do not hold: ${excess.join(', ')}`);
    const days = Math.min(expiresInDays, this.ctx.config.auth.tokenMaxTtlDays);
    const token = await this.issueToken(principal.userId, {
      name,
      kind: 'api',
      ttlSeconds: days * 86400,
      scopes: requested,
    });
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'token.created',
      target: token.id,
      payload: { name, scopes: requested, expiresAt: token.expiresAt },
    });
    return token;
  }

  /** API tokens of one user, or of every user of the actor's tenant (`userId` null). */
  async listTokens(actor: TenantActor, userId: string | null): Promise<TokenInfo[]> {
    const rows = await this.ctx.db
      .select({ token: apiTokens })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(
        and(
          eq(users.tenantId, actor.tenantId),
          userId ? eq(apiTokens.userId, userId) : undefined,
          eq(apiTokens.kind, 'api'),
          isNull(apiTokens.revokedAt),
        ),
      )
      .orderBy(desc(apiTokens.createdAt))
      .limit(500);
    return rows.map((r) => toTokenInfo(r.token));
  }

  async revokeToken(principal: Principal, id: string, allowAny: boolean): Promise<void> {
    const [found] = await this.ctx.db
      .select({ token: apiTokens, tenantId: users.tenantId })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.id, id));
    const row = found?.token;
    if (
      !found ||
      found.tenantId !== principal.tenantId ||
      (!allowAny && row!.userId !== principal.userId)
    )
      throw notFound('token');
    await this.ctx.db
      .update(apiTokens)
      .set({ revokedAt: this.ctx.now() })
      .where(eq(apiTokens.id, id));
    await this.ctx.cache.del(`auth:${id}`);
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'token.revoked',
      target: id,
    });
  }

  async logout(bearer: string): Promise<void> {
    const parsed = parseToken(bearer);
    if (!parsed) return;
    await this.ctx.db
      .update(apiTokens)
      .set({ revokedAt: this.ctx.now() })
      .where(eq(apiTokens.id, parsed.id));
    await this.ctx.cache.del(`auth:${parsed.id}`);
  }

  // ---------- login ----------

  private async session(
    user: UserRow,
    method: string,
  ): Promise<{ token: string; expiresAt: Date; user: PublicUser }> {
    const issued = await this.issueToken(user.id, {
      name: `session:${method}`,
      kind: 'session',
      ttlSeconds: this.ctx.config.auth.sessionTtlSeconds,
    });
    await this.ctx.db
      .update(users)
      .set({ lastLoginAt: this.ctx.now() })
      .where(eq(users.id, user.id));
    await this.audit.append({
      actor: user.id,
      tenantId: user.tenantId,
      action: 'auth.login',
      target: user.email,
      payload: { method },
    });
    return { token: issued.token, expiresAt: issued.expiresAt, user: await this.publicUser(user) };
  }

  async login(username: string, password: string, method: 'local' | 'ldap' | 'auto' = 'auto') {
    const email = username.toLowerCase();
    const [local] = await this.ctx.db.select().from(users).where(eq(users.email, email));
    if ((method === 'local' || method === 'auto') && local?.source === 'local') {
      if (local.disabled || !(await verifyPassword(password, local.passwordHash))) {
        await this.audit.append({
          actor: 'anonymous',
          action: 'auth.failed',
          target: email,
          payload: { method: 'local' },
        });
        throw unauthenticated('invalid credentials');
      }
      return this.session(local, 'local');
    }
    const ldap = this.ctx.config.auth.ldap;
    if (ldap && (method === 'ldap' || method === 'auto')) {
      let identity;
      try {
        identity = await ldapAuthenticate(ldap, username, password, this.ctx.ldapFactory);
      } catch (e) {
        await this.audit.append({
          actor: 'anonymous',
          action: 'auth.failed',
          target: username,
          payload: { method: 'ldap' },
        });
        if (e instanceof OaxError && e.code === 'unauthenticated')
          throw unauthenticated('invalid credentials');
        throw e;
      }
      const user = await this.upsertExternalUser(
        'ldap',
        identity.dn,
        identity.email,
        identity.displayName,
        mapGroupsToBindings(identity.groups, ldap.roleMapping),
      );
      return this.session(user, 'ldap');
    }
    await this.audit.append({
      actor: 'anonymous',
      action: 'auth.failed',
      target: email,
      payload: { method },
    });
    throw unauthenticated('invalid credentials');
  }

  /** Creates or updates an LDAP/OIDC user and replaces its role bindings from the group mapping. */
  async upsertExternalUser(
    source: 'ldap' | 'oidc',
    externalId: string,
    email: string,
    displayName: string,
    mapped: MappedBinding[],
  ): Promise<UserRow> {
    const globalRoles = mapped.filter((m) => m.teamSlug === null).map((m) => m.role);
    const lower = email.toLowerCase();
    const [existing] = await this.ctx.db.select().from(users).where(eq(users.email, lower));
    // External identities land in the default tenant (or stay in the tenant they were created in).
    const tenantId = existing?.tenantId ?? DEFAULT_TENANT_ID;
    if (existing && existing.source !== source)
      throw conflict(`user ${lower} exists with source ${existing.source}`);
    const id = existing?.id ?? randomUUID();
    if (existing) {
      if (existing.disabled) throw unauthenticated('user is disabled');
      await this.ctx.db
        .update(users)
        .set({ displayName, globalRoles, externalId })
        .where(eq(users.id, id));
    } else {
      await this.ctx.db
        .insert(users)
        .values({ id, email: lower, displayName, source, externalId, globalRoles, tenantId });
    }
    const slugs = [...new Set(mapped.filter((m) => m.teamSlug).map((m) => m.teamSlug!))];
    const teamRows = slugs.length
      ? await this.ctx.db
          .select()
          .from(teams)
          .where(and(inArray(teams.slug, slugs), eq(teams.tenantId, tenantId)))
      : [];
    await this.ctx.db.delete(teamMembers).where(eq(teamMembers.userId, id));
    const values = mapped
      .filter((m) => m.teamSlug)
      .map((m) => ({
        teamId: teamRows.find((t) => t.slug === m.teamSlug)?.id,
        userId: id,
        role: m.role,
      }))
      .filter((v): v is { teamId: string; userId: string; role: Role } => !!v.teamId);
    if (values.length) await this.ctx.db.insert(teamMembers).values(values).onConflictDoNothing();
    const [row] = await this.ctx.db.select().from(users).where(eq(users.id, id));
    return row!;
  }

  async oidcStart(): Promise<string> {
    if (!this.oidc) throw new HttpError(404, 'not_found', 'OIDC is not configured');
    const v = randomOidcValues();
    await this.ctx.db.delete(oidcStates).where(lt(oidcStates.expiresAt, this.ctx.now()));
    await this.ctx.db.insert(oidcStates).values({
      state: v.state,
      nonce: v.nonce,
      codeVerifier: v.codeVerifier,
      expiresAt: new Date(this.ctx.now().getTime() + 600_000),
    });
    return this.oidc.authorizationUrl({
      state: v.state,
      nonce: v.nonce,
      codeChallenge: await pkceChallenge(v.codeVerifier),
    });
  }

  async oidcCallback(currentUrl: URL) {
    const cfg = this.ctx.config.auth.oidc;
    if (!this.oidc || !cfg) throw new HttpError(404, 'not_found', 'OIDC is not configured');
    const state = currentUrl.searchParams.get('state') ?? '';
    const [row] = await this.ctx.db
      .delete(oidcStates)
      .where(eq(oidcStates.state, state))
      .returning();
    if (!row || row.expiresAt.getTime() < this.ctx.now().getTime())
      throw unauthenticated('unknown or expired login state');
    const claims = await this.oidc.exchange(currentUrl, {
      state,
      nonce: row.nonce,
      codeVerifier: row.codeVerifier,
    });
    const email =
      typeof claims.email === 'string' ? claims.email : `${String(claims.sub)}@oidc.invalid`;
    const name = typeof claims.name === 'string' ? claims.name : email;
    const rawGroups = claims[cfg.groupsClaim];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.map(String)
      : typeof rawGroups === 'string'
        ? [rawGroups]
        : [];
    const user = await this.upsertExternalUser(
      'oidc',
      String(claims.sub),
      email,
      name,
      mapGroupsToBindings(groups, cfg.roleMapping),
    );
    return this.session(user, 'oidc');
  }

  // ---------- users & teams ----------

  async publicUser(u: UserRow): Promise<PublicUser> {
    const memberships = await this.ctx.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, u.id));
    return {
      id: u.id,
      tenantId: u.tenantId,
      email: u.email,
      displayName: u.displayName,
      source: u.source,
      globalRoles: u.globalRoles,
      disabled: u.disabled,
      teams: memberships.map((m) => ({ teamId: m.teamId, role: m.role })),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  /** `tenantId` restricts the lookup to one tenant (omit only for the caller's own record). */
  async getUser(id: string, tenantId?: string): Promise<PublicUser> {
    const [u] = await this.ctx.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), tenantId ? eq(users.tenantId, tenantId) : undefined));
    if (!u) throw notFound('user');
    return this.publicUser(u);
  }

  async listUsers(actor: TenantActor): Promise<PublicUser[]> {
    const rows = await this.ctx.db
      .select()
      .from(users)
      .where(eq(users.tenantId, actor.tenantId))
      .orderBy(users.email)
      .limit(1000);
    return Promise.all(rows.map((u) => this.publicUser(u)));
  }

  async createLocalUser(
    actor: TenantActor,
    input: { email: string; displayName: string; password: string; globalRoles: Role[] },
  ): Promise<PublicUser> {
    const email = input.email.toLowerCase();
    const [exists] = await this.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (exists) throw conflict(`user ${email} already exists`);
    const id = randomUUID();
    await this.ctx.db.insert(users).values({
      id,
      email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      source: 'local',
      globalRoles: input.globalRoles,
      tenantId: actor.tenantId,
    });
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'user.created',
      target: id,
      payload: { email, globalRoles: input.globalRoles },
    });
    return this.getUser(id, actor.tenantId);
  }

  async updateUser(
    actor: TenantActor,
    id: string,
    patch: {
      displayName?: string | undefined;
      globalRoles?: Role[] | undefined;
      disabled?: boolean | undefined;
    },
  ): Promise<PublicUser> {
    const set: Partial<UserRow> = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.globalRoles !== undefined) set.globalRoles = patch.globalRoles;
    if (patch.disabled !== undefined) set.disabled = patch.disabled;
    const updated = await this.ctx.db
      .update(users)
      .set(set)
      .where(and(eq(users.id, id), eq(users.tenantId, actor.tenantId)))
      .returning();
    if (updated.length === 0) throw notFound('user');
    await this.invalidateUserTokens(id);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'user.updated',
      target: id,
      payload: patch,
    });
    return this.getUser(id, actor.tenantId);
  }

  private async invalidateUserTokens(userId: string): Promise<void> {
    const tokens = await this.ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId));
    await Promise.all(tokens.map((t) => this.ctx.cache.del(`auth:${t.id}`)));
  }

  async listTeams(actor: TenantActor): Promise<TeamRow[]> {
    return cached(this.ctx.cache, `teams:${actor.tenantId}`, 60_000, () =>
      this.ctx.db
        .select()
        .from(teams)
        .where(eq(teams.tenantId, actor.tenantId))
        .orderBy(teams.slug),
    );
  }

  async getTeam(actor: TenantActor, id: string): Promise<TeamRow> {
    const [t] = await this.ctx.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.tenantId, actor.tenantId)));
    if (!t) throw notFound('team');
    return t;
  }

  async createTeam(
    actor: TenantActor,
    input: { slug: string; name: string; monthlyBudgetUsd?: number | undefined },
  ): Promise<TeamRow> {
    const [exists] = await this.ctx.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.slug, input.slug), eq(teams.tenantId, actor.tenantId)));
    if (exists) throw conflict(`team ${input.slug} already exists`);
    const [row] = await this.ctx.db
      .insert(teams)
      .values({
        id: randomUUID(),
        tenantId: actor.tenantId,
        slug: input.slug,
        name: input.name,
        monthlyBudgetMicros:
          input.monthlyBudgetUsd === undefined ? null : Math.round(input.monthlyBudgetUsd * 1e6),
      })
      .returning();
    await this.ctx.cache.del(`teams:${actor.tenantId}`);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'team.created',
      target: row!.id,
      payload: input,
    });
    return row!;
  }

  async updateTeam(
    actor: TenantActor,
    teamId: string,
    patch: { name?: string | undefined; monthlyBudgetUsd?: number | null | undefined },
  ): Promise<TeamRow> {
    await this.getTeam(actor, teamId);
    const set: Partial<TeamRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.monthlyBudgetUsd !== undefined)
      set.monthlyBudgetMicros =
        patch.monthlyBudgetUsd === null ? null : Math.round(patch.monthlyBudgetUsd * 1e6);
    const [row] = await this.ctx.db.update(teams).set(set).where(eq(teams.id, teamId)).returning();
    await this.ctx.cache.del(`teams:${actor.tenantId}`);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'team.updated',
      target: teamId,
      payload: patch,
    });
    return row!;
  }

  async teamMembers(
    actor: TenantActor,
    teamId: string,
  ): Promise<{ userId: string; email: string; displayName: string; role: string }[]> {
    await this.getTeam(actor, teamId);
    return this.ctx.db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(users.email);
  }

  /** Deletes a team that owns no agents (memberships are removed with it). */
  async deleteTeam(actor: TenantActor, teamId: string): Promise<void> {
    await this.getTeam(actor, teamId);
    const [owned] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.teamId, teamId))
      .limit(1);
    if (owned) throw conflict('team still owns agents; move or archive them first');
    const members = await this.ctx.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));
    await this.ctx.db.delete(teams).where(eq(teams.id, teamId));
    await Promise.all(members.map((m) => this.invalidateUserTokens(m.userId)));
    await this.ctx.cache.del(`teams:${actor.tenantId}`);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'team.deleted',
      target: teamId,
    });
  }

  async setTeamMembers(
    actor: TenantActor,
    teamId: string,
    members: { userId: string; role: Role }[],
  ): Promise<void> {
    await this.getTeam(actor, teamId);
    await this.assertUsersInTenant(
      actor,
      members.map((m) => m.userId),
    );
    await this.ctx.db.transaction(async (tx) => {
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
      if (members.length)
        await tx
          .insert(teamMembers)
          .values(members.map((m) => ({ teamId, userId: m.userId, role: m.role })))
          .onConflictDoNothing();
    });
    await Promise.all(
      [...new Set(members.map((m) => m.userId))].map((u) => this.invalidateUserTokens(u)),
    );
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'team.members.set',
      target: teamId,
      payload: { members },
    });
  }
}

function toTokenInfo(r: typeof apiTokens.$inferSelect): TokenInfo {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  };
}
