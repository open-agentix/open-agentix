import {
  ancestorIds,
  declaredSecretReferences,
  nearestTenantSecret,
  parseNameGlobs,
  parseSecretRef,
  secretResolutionDigestOf,
  type AgentDefinition,
  type ChainNode,
  type SecretPin,
} from '@openagentix/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { secrets, tenants } from '../db/schema.js';
import type { SecretRow } from './secret-store.js';

/**
 * Where an agent lives, for the purpose of resolving its secret references: the node (the chain the
 * tenant references walk), the team (the team references), and, for development runs only, the user
 * who starts the run (the personal references).
 */
export interface ResolveScope {
  tenantId: string;
  teamId: string | null;
  starterUserId?: string | null;
}

/** A reference with what it resolved to; `secret` is set exactly when the pin is `resolved`. */
export interface Resolved {
  pin: SecretPin;
  secret?: SecretRow;
}

export type SecretState = 'active' | 'expired' | 'revoked';

export function stateOf(s: Pick<SecretRow, 'revokedAt' | 'expiresAt'>, now: Date): SecretState {
  if (s.revokedAt) return 'revoked';
  if (s.expiresAt && s.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** The `blockInherited` globs a node stores; an unreadable value blocks everything (fail closed). */
export function blockedGlobsOf(settings: unknown): string[] {
  const raw = (settings as { secrets?: { blockInherited?: unknown } } | null)?.secrets
    ?.blockInherited;
  if (raw === undefined) return [];
  return parseNameGlobs(raw) ?? ['*'];
}

export interface ChainView {
  /** Nearest first: the node itself, its parent, ..., the root. */
  nodes: ChainNode[];
  /** The ids of those nodes, for membership tests. */
  ids: Set<string>;
}

/**
 * Resolves secret references to the secret each one names (ADR 0017 section 13.2 and 13.3). Pure
 * lookups, no values and no authorisation: callers decide who may see or use the result. There is no
 * fallback between scopes: the prefix of a reference is the only scope that is searched.
 */
export class SecretResolution {
  constructor(private readonly ctx: AppContext) {}

  /** The chain of a node with the `blockInherited` globs of each node. */
  async chainOf(db: Db, tenantId: string): Promise<ChainView | null> {
    const [node] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!node) return null;
    const ids = [node.id, ...ancestorIds(node.path).reverse()];
    const rows = await db.select().from(tenants).where(inArray(tenants.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (ids.some((id) => !byId.has(id))) return null;
    return {
      nodes: ids.map((id) => ({ id, blockInherited: blockedGlobsOf(byId.get(id)!.settings) })),
      ids: new Set(ids),
    };
  }

  /** Resolves each reference of `refs` (deduplicated) for an agent at `scope`. */
  async resolve(db: Db, scope: ResolveScope, refs: readonly string[]): Promise<Resolved[]> {
    const distinct = [...new Set(refs)].sort();
    const parsed = distinct.map((r) => ({ ref: r, p: parseSecretRef(r) }));
    const tenantNames = parsed.flatMap(({ p }) =>
      p?.kind === 'scoped' && p.scope === 'tenant' ? [p.name] : [],
    );
    const chain = tenantNames.length > 0 ? await this.chainOf(db, scope.tenantId) : null;
    const tenantRows = chain
      ? await db
          .select()
          .from(secrets)
          .where(
            and(
              eq(secrets.scope, 'tenant'),
              inArray(secrets.tenantId, [...chain.ids]),
              inArray(secrets.name, tenantNames),
            ),
          )
      : [];
    const out: Resolved[] = [];
    for (const { ref, p } of parsed) {
      if (!p) out.push({ pin: { ref, state: 'unresolved', code: 'secret_not_found' } });
      else if (p.kind === 'legacy') out.push({ pin: { ref, state: 'legacy' } });
      else if (p.scope === 'personal') out.push(await this.personal(db, scope, ref, p.name));
      else if (p.scope === 'team') out.push(await this.team(db, scope, ref, p.name));
      else out.push(this.tenant(chain, tenantRows, ref, p.name));
    }
    return out;
  }

  private tenant(
    chain: ChainView | null,
    rows: readonly SecretRow[],
    ref: string,
    name: string,
  ): Resolved {
    const candidates = rows
      .filter((r) => r.name === name)
      .map((r) => ({ ownerId: r.tenantId, inherit: r.inherit, row: r }));
    const hit = chain ? nearestTenantSecret(chain.nodes, candidates, name) : null;
    return hit ? resolved(ref, hit.row) : unresolved(ref, 'secret_not_found');
  }

  private async team(db: Db, scope: ResolveScope, ref: string, name: string): Promise<Resolved> {
    if (!scope.teamId) return unresolved(ref, 'secret_not_found');
    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.scope, 'team'),
          eq(secrets.scopeId, scope.teamId),
          eq(secrets.tenantId, scope.tenantId),
          eq(secrets.name, name),
        ),
      );
    return row ? resolved(ref, row) : unresolved(ref, 'secret_not_found');
  }

  /**
   * A personal reference resolves against the user who STARTS a run, so a version cannot carry one:
   * without a starter (every published version) it never resolves.
   */
  private async personal(
    db: Db,
    scope: ResolveScope,
    ref: string,
    name: string,
  ): Promise<Resolved> {
    if (!scope.starterUserId) return unresolved(ref, 'personal_secret_in_version');
    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.scope, 'personal'),
          eq(secrets.scopeId, scope.starterUserId),
          eq(secrets.tenantId, scope.tenantId),
          eq(secrets.name, name),
        ),
      );
    return row ? resolved(ref, row) : unresolved(ref, 'secret_not_found');
  }

  /** The pins of every credential reference a definition declares, and their digest. */
  async pinsFor(
    db: Db,
    scope: ResolveScope,
    def: Pick<AgentDefinition, 'agents'>,
  ): Promise<{ resolved: Resolved[]; pins: SecretPin[]; digest: string }> {
    const resolvedRefs = await this.resolve(db, scope, declaredSecretReferences(def));
    const pins = resolvedRefs.map((r) => r.pin);
    return { resolved: resolvedRefs, pins, digest: secretResolutionDigestOf(pins) };
  }
}

const resolved = (ref: string, row: SecretRow): Resolved => ({
  pin: { ref, state: 'resolved', scope: row.scope, ownerNode: row.tenantId, secretId: row.id },
  secret: row,
});

const unresolved = (ref: string, code: string): Resolved => ({
  pin: { ref, state: 'unresolved', code },
});

/** A scoped secret of another node that a version would pin (inherited from an ancestor). */
export interface ForeignSecret {
  ref: string;
  scope: string;
  ownerNode: string;
}

/**
 * The scoped secrets a version would pin that belong to ANOTHER node than the agent's own: inherited
 * from an ancestor (ADR 0017 section 13.3). Using one always needs an approved review (see
 * `PublishGate`), whatever the lifecycle policy says: the agent's author may not hand a credential
 * of a higher node to a step on their own authority.
 */
export function foreignOf(
  agent: { tenantId: string },
  resolved: readonly Resolved[],
): ForeignSecret[] {
  return resolved.flatMap((r) =>
    r.secret && r.secret.scope === 'tenant' && r.secret.tenantId !== agent.tenantId
      ? [{ ref: r.pin.ref, scope: r.secret.scope, ownerNode: r.secret.tenantId }]
      : [],
  );
}
