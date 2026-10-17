import {
  OaxError,
  destinationsAllowed,
  nameBlocked,
  canonicalSecretRef,
  secretRefAllowed,
  type AgentDefinition,
  type AgentSpec,
  type SecretPin,
  type SecretResolutionCode,
} from '@openagentix/core';
import type { McpServerConfig } from '@openagentix/mcp';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agentVersions, secrets, tenants, type runs } from '../db/schema.js';
import { platformSecretRefs } from './platform-secrets.js';
import { stateOf, type SecretResolution } from './secret-resolution.js';
import type { SecretRow, SecretStore } from './secret-store.js';

type RunRow = typeof runs.$inferSelect;

/** A refusal to issue a scoped secret: a stable code and the reference, never a value or a reason text. */
export class SecretDenied extends OaxError {
  constructor(
    code: SecretResolutionCode,
    readonly ref: string,
  ) {
    super(code, `secret "${ref}" cannot be issued (${code})`);
  }
}

/** A scoped secret that passed every check and can be opened for exactly one issuance. */
export interface PreparedSecret {
  ref: string;
  secret: SecretRow;
}

/** What the audit entry of an issuance records about a scoped secret (never the value). */
export function issuanceRecord(p: PreparedSecret) {
  return {
    ref: p.ref,
    scope: p.secret.scope,
    ownerNode: p.secret.tenantId,
    secretId: p.secret.id,
    secretVersion: p.secret.currentVersion,
    backend: p.secret.backend,
  };
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * Every network destination the step can reach: its effective egress (a step can only narrow the
 * run's) and the hosts of the MCP connections it holds grants for. An entry that cannot be parsed
 * stays in the list and is refused by {@link destinationsAllowed} (fail closed).
 */
export function stepDestinations(
  definition: Pick<AgentDefinition, 'runtime'>,
  agent: Pick<AgentSpec, 'runtime'>,
  configs: readonly McpServerConfig[],
): string[] {
  const out = [...(agent.runtime?.egress ?? definition.runtime.egress)];
  for (const c of configs) {
    if (c.transport === 'stdio') out.push(...(c.egress ?? []));
    else if (c.transport === 'streamable-http') {
      out.push(hostOf(c.url) ?? c.url, ...(c.egress ?? []));
    }
  }
  return out;
}

/**
 * Issues scoped secrets to the steps of a run (ADR 0017 section 13.8), the run-time half of the
 * credential broker. A production run uses exactly the secret its version **pinned** at publish
 * (owning node and secret id): there is no lookup by name here, so a secret created later at a nearer
 * node cannot take over, and a pinned secret that is revoked, expired, deleted, blocked or no longer
 * on the chain fails closed with a code (`secret_unavailable`, `secret_out_of_chain`, ...) and never
 * falls back to another one. The plaintext exists only in {@link open}'s return value.
 */
export class ScopedSecretBroker {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: SecretStore,
    private readonly resolution: SecretResolution,
  ) {}

  /** Checks every scoped reference of a step; throws {@link SecretDenied} at the first failure. */
  async prepare(
    run: RunRow,
    refs: readonly string[],
    step: { destinations: readonly string[] },
  ): Promise<PreparedSecret[]> {
    if (refs.length === 0) return [];
    const pins = await this.pinsOf(run.agentVersionId);
    const chain = await this.resolution.chainOf(this.ctx.db, run.tenantId);
    const out: PreparedSecret[] = [];
    for (const ref of refs) {
      const secret = await this.pinned(pins.get(ref), ref);
      this.assertScope(run, chain, secret, ref);
      await this.assertUsable(run, secret, ref, step.destinations);
      out.push({ ref, secret });
    }
    return out;
  }

  /** The plaintext of a prepared secret, for one issuance. */
  async open(p: PreparedSecret): Promise<string> {
    if (p.secret.backend === 'env') return this.ctx.secrets.resolve(p.secret.pointer!);
    return this.store.open(p.secret);
  }

  /**
   * The value of a pinned secret for redaction only (no policy checks: a value that was issued must
   * be scrubbed even if the secret was revoked since). `null` when it cannot be read any more.
   */
  async valueForRedaction(run: RunRow, ref: string): Promise<string | null> {
    try {
      const pin = (await this.pinsOf(run.agentVersionId)).get(ref);
      if (pin?.state !== 'resolved') return null;
      const [secret] = await this.ctx.db.select().from(secrets).where(eq(secrets.id, pin.secretId));
      return secret && !secret.revokedAt ? await this.open({ ref, secret }) : null;
    } catch {
      return null;
    }
  }

  private async pinsOf(versionId: string): Promise<Map<string, SecretPin>> {
    const [v] = await this.ctx.db
      .select({ pins: agentVersions.secretResolution })
      .from(agentVersions)
      .where(eq(agentVersions.id, versionId));
    const pins = (v?.pins ?? []).filter((p): p is SecretPin => typeof p === 'object');
    return new Map(pins.map((p) => [p.ref, p]));
  }

  private async pinned(pin: SecretPin | undefined, ref: string): Promise<SecretRow> {
    if (pin?.state !== 'resolved') throw new SecretDenied('secret_unavailable', ref);
    const [secret] = await this.ctx.db.select().from(secrets).where(eq(secrets.id, pin.secretId));
    if (!secret || secret.tenantId !== pin.ownerNode)
      throw new SecretDenied('secret_unavailable', ref);
    if (stateOf(secret, this.ctx.now()) !== 'active')
      throw new SecretDenied('secret_unavailable', ref);
    return secret;
  }

  /** The secret is still where the pin says: on the run's chain, not blocked on the way down. */
  private assertScope(
    run: RunRow,
    chain: Awaited<ReturnType<SecretResolution['chainOf']>>,
    secret: SecretRow,
    ref: string,
  ): void {
    if (secret.scope === 'personal') throw new SecretDenied('secret_scope_not_usable', ref);
    if (secret.scope === 'team') {
      if (secret.tenantId !== run.tenantId || secret.scopeId !== run.teamId)
        throw new SecretDenied('secret_out_of_chain', ref);
      return;
    }
    if (!chain || !chain.ids.has(secret.tenantId))
      throw new SecretDenied('secret_out_of_chain', ref);
    const ownerAt = chain.nodes.findIndex((n) => n.id === secret.tenantId);
    if (ownerAt > 0 && !secret.inherit) throw new SecretDenied('secret_out_of_chain', ref);
    // `blockInherited` of a node hides names owned ABOVE it: the nodes below the owner decide.
    if (chain.nodes.slice(0, ownerAt).some((n) => nameBlocked(n.blockInherited, secret.name)))
      throw new SecretDenied('secret_unavailable', ref);
  }

  private async assertUsable(
    run: RunRow,
    secret: SecretRow,
    ref: string,
    destinations: readonly string[],
  ): Promise<void> {
    // Every run of a published version is a production run (development runs do not exist yet).
    if (secret.usage === 'development') throw new SecretDenied('secret_not_usable', ref);
    if (
      secret.allowedDestinations.length > 0 &&
      !destinationsAllowed(secret.allowedDestinations, destinations)
    )
      throw new SecretDenied('secret_destination_denied', ref);
    if (secret.backend !== 'env') return;
    // A pointer stays inside what the run's tenant may reference today, and never reaches the platform.
    const [t] = await this.ctx.db
      .select({ refs: tenants.secretRefs })
      .from(tenants)
      .where(eq(tenants.id, run.tenantId));
    const pointer = secret.pointer!;
    if (
      !t ||
      !secretRefAllowed(t.refs, pointer) ||
      (await platformSecretRefs(this.ctx)).has(canonicalSecretRef(pointer))
    )
      throw new SecretDenied('secret_not_usable', ref);
  }
}
