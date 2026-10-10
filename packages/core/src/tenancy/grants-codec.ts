import { isRole, type Role } from '../rbac.js';
import { isValidPath } from './path.js';
import type { AgentRoleGrant, NodeRoleGrant, RawGrants, RoleNode, TeamRoleGrant } from './roles.js';

/**
 * Serializable form of the raw grants (ADR 0014 section 6.2), for a JSON cache such as Valkey.
 *
 * `NodeRoleGrant.expiresAt` is a `Date`, which JSON turns into a string and never turns back. The
 * wire form therefore carries `expiresAt` as a canonical ISO-8601 UTC string
 * (`Date.prototype.toISOString`), and {@link reviveGrants} parses it back strictly. The rule is
 * fail closed: anything that is not exactly what {@link serializeGrants} writes (an unknown
 * version, a missing field, a non-canonical or impossible date, an unknown role, an extra
 * `inherit` type) makes the whole entry unusable (`undefined`), so the caller reloads the grants
 * from the database instead of acting on a partly understood cache entry. Nothing is ever
 * repaired, defaulted or guessed.
 */
export const GRANTS_WIRE_VERSION = 1;

export interface WireNodeGrant {
  tenantId: string;
  role: string;
  useCase: string | null;
  inherit: boolean;
  /** Canonical ISO-8601 UTC string (`2026-10-10T12:00:00.000Z`) or `null` for no expiry. */
  expiresAt: string | null;
}

export interface WireGrants {
  v: typeof GRANTS_WIRE_VERSION;
  raw: {
    userId: string;
    homeTenantId: string;
    homeRootId: string;
    platformAdmin: boolean;
    nodeBindings: WireNodeGrant[];
    teamBindings: TeamRoleGrant[];
    agentBindings: AgentRoleGrant[];
  };
  home: RoleNode;
}

/** The result of loading the grants of a user: the raw grants and the home node's placement. */
export interface GrantsAndHome {
  raw: RawGrants;
  home: RoleNode;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `Date` to its canonical wire string; `undefined` for an invalid date (never `"Invalid Date"`). */
export function dateToWire(d: Date): string | undefined {
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/** The inverse of {@link dateToWire}: only the canonical form is accepted, round trip checked. */
export function dateFromWire(s: unknown): Date | undefined {
  if (typeof s !== 'string' || !ISO_UTC.test(s)) return undefined;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) && d.toISOString() === s ? d : undefined;
}

/**
 * The wire form of loaded grants. A binding whose expiry is not a valid `Date` is *dropped* (it
 * could never apply: the resolver treats it as expired), so the cache never contains a value it
 * could not read back.
 */
export function serializeGrants(g: GrantsAndHome): WireGrants {
  const nodeBindings: WireNodeGrant[] = [];
  for (const b of g.raw.nodeBindings) {
    let expiresAt: string | null = null;
    if (b.expiresAt !== null) {
      const w = b.expiresAt instanceof Date ? dateToWire(b.expiresAt) : undefined;
      if (w === undefined) continue;
      expiresAt = w;
    }
    nodeBindings.push({
      tenantId: b.tenantId,
      role: b.role,
      useCase: b.useCase,
      inherit: b.inherit,
      expiresAt,
    });
  }
  return {
    v: GRANTS_WIRE_VERSION,
    raw: {
      userId: g.raw.userId,
      homeTenantId: g.raw.homeTenantId,
      homeRootId: g.raw.homeRootId,
      platformAdmin: g.raw.platformAdmin,
      nodeBindings,
      teamBindings: g.raw.teamBindings.map((b) => ({ ...b })),
      agentBindings: g.raw.agentBindings.map((b) => ({ ...b })),
    },
    home: { id: g.home.id, rootId: g.home.rootId, path: g.home.path },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function reviveNode(v: unknown): NodeRoleGrant | undefined {
  if (!isObj(v)) return undefined;
  if (!isStr(v.tenantId) || typeof v.role !== 'string' || !isRole(v.role)) return undefined;
  if (v.useCase !== null && !isStr(v.useCase)) return undefined;
  if (typeof v.inherit !== 'boolean') return undefined;
  let expiresAt: Date | null = null;
  if (v.expiresAt !== null) {
    const d = dateFromWire(v.expiresAt);
    if (!d) return undefined;
    expiresAt = d;
  }
  return {
    tenantId: v.tenantId,
    role: v.role as Role,
    useCase: v.useCase,
    inherit: v.inherit,
    expiresAt,
  };
}

function reviveAll<T>(list: unknown, one: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: T[] = [];
  for (const item of list) {
    const r = one(item);
    if (r === undefined) return undefined;
    out.push(r);
  }
  return out;
}

function reviveTeam(v: unknown): TeamRoleGrant | undefined {
  if (!isObj(v) || !isStr(v.tenantId) || !isStr(v.teamId)) return undefined;
  if (typeof v.role !== 'string' || !isRole(v.role)) return undefined;
  return { tenantId: v.tenantId, teamId: v.teamId, role: v.role as Role };
}

function reviveAgent(v: unknown): AgentRoleGrant | undefined {
  if (!isObj(v) || !isStr(v.tenantId) || !isStr(v.agentId)) return undefined;
  if (v.teamId !== null && !isStr(v.teamId)) return undefined;
  if (typeof v.role !== 'string' || !isRole(v.role)) return undefined;
  return {
    tenantId: v.tenantId,
    agentId: v.agentId,
    teamId: v.teamId as string | null,
    role: v.role as Role,
  };
}

/**
 * Parses a value read from a JSON cache back into loaded grants, or `undefined` (treat as a cache
 * miss and reload) when it is not exactly a current {@link WireGrants}. Revived `expiresAt` values
 * are real `Date`s again, so a binding that expires later still applies until then.
 */
export function reviveGrants(value: unknown): GrantsAndHome | undefined {
  if (!isObj(value) || value.v !== GRANTS_WIRE_VERSION) return undefined;
  const r = value.raw;
  const h = value.home;
  if (!isObj(r) || !isObj(h)) return undefined;
  if (!isStr(r.userId) || !isStr(r.homeTenantId) || !isStr(r.homeRootId)) return undefined;
  if (typeof r.platformAdmin !== 'boolean') return undefined;
  if (!isStr(h.id) || !isStr(h.rootId) || typeof h.path !== 'string' || !isValidPath(h.path))
    return undefined;
  const nodeBindings = reviveAll(r.nodeBindings, reviveNode);
  const teamBindings = reviveAll(r.teamBindings, reviveTeam);
  const agentBindings = reviveAll(r.agentBindings, reviveAgent);
  if (!nodeBindings || !teamBindings || !agentBindings) return undefined;
  return {
    raw: {
      userId: r.userId,
      homeTenantId: r.homeTenantId,
      homeRootId: r.homeRootId,
      platformAdmin: r.platformAdmin,
      nodeBindings,
      teamBindings,
      agentBindings,
    },
    home: { id: h.id, rootId: h.rootId, path: h.path },
  };
}
