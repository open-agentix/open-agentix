import {
  OaxError,
  destinationsAllowed,
  devRunSecretVerdict,
  productionRunSecretVerdict,
  nameBlocked,
  parseSecretRef,
  canonicalSecretRef,
  secretRefAllowed,
  type AgentDefinition,
  type AgentSpec,
  type SecretPin,
  type SecretResolutionCode,
  type SecretUsage,
} from '@openagentix/core';
import type { McpServerConfig } from '@openagentix/mcp';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agentDraftRevisions, agentVersions, secrets, tenants, type runs } from '../db/schema.js';
import { platformSecretRefs } from './platform-secrets.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';
import { stateOf, type Resolved, type SecretResolution } from './secret-resolution.js';
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
 * credential broker. A development run (a draft revision, ADR 0017 section 8) resolves its references
 * live, for the user who started it, under the rules of `devRunSecretVerdict`. A production run uses
 * exactly the secret its version **pinned** at publish
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
    private readonly policy: Pick<LifecyclePolicyService, 'effectiveForTenant'>,
    /**
     * Whether the user who started a development run may still use their personal secrets: the
     * account is active and still holds `agents:write` on the agent. Fail closed (`false`) on any error.
     */
    private readonly starterEntitled: (run: RunRow) => Promise<boolean>,
  ) {}

  /**
   * Checks every scoped reference of a step; throws {@link SecretDenied} at the first failure. A run
   * of a published version uses the secrets its version pinned; a development run (a draft revision)
   * resolves live, for the user who started it.
   */
  async prepare(
    run: RunRow,
    refs: readonly string[],
    step: { destinations: readonly string[] },
  ): Promise<PreparedSecret[]> {
    if (refs.length === 0) return [];
    return run.stage === 'development'
      ? this.prepareDevelopment(run, refs, step)
      : this.prepareProduction(run, refs, step);
  }

  private async prepareProduction(
    run: RunRow,
    refs: readonly string[],
    step: { destinations: readonly string[] },
  ): Promise<PreparedSecret[]> {
    const pins = await this.pinsOf(run.agentVersionId);
    const chain = await this.resolution.chainOf(this.ctx.db, run.tenantId);
    const out: PreparedSecret[] = [];
    for (const ref of refs) {
      const secret = await this.pinned(pins.get(ref), ref);
      const verdict = productionRunSecretVerdict({
        scope: secret.scope as 'personal' | 'team' | 'tenant',
        usage: secret.usage as SecretUsage,
      });
      if (verdict) throw new SecretDenied(verdict, ref);
      this.assertScope(run, chain, secret, ref);
      await this.assertUsable(run, secret, ref, step.destinations);
      out.push({ ref, secret });
    }
    return out;
  }

  /**
   * A development run resolves its references now (nearest owner along the chain, personal ones against
   * the user who started the run) and applies the development rules of `devRunSecretVerdict`. The
   * policy is read at issuance, so tightening it takes effect for runs already going.
   */
  private async prepareDevelopment(
    run: RunRow,
    refs: readonly string[],
    step: { destinations: readonly string[] },
  ): Promise<PreparedSecret[]> {
    // A development run acts as its starter: once they are disabled or lost `agents:write`, no secret
    // of any scope is issued to it any more.
    if (!(await this.starterEntitled(run)))
      throw new SecretDenied('secret_owner_unavailable', refs[0]!);
    const policy = await this.policy.effectiveForTenant(run.tenantId);
    const resolved = await this.resolution.resolve(
      this.ctx.db,
      { tenantId: run.tenantId, teamId: run.teamId, starterUserId: run.startedBy },
      refs,
    );
    const byRef = new Map(resolved.map((r) => [r.pin.ref, r]));
    const chain = await this.resolution.chainOf(this.ctx.db, run.tenantId);
    const out: PreparedSecret[] = [];
    for (const ref of refs) {
      const secret = this.resolvedSecret(byRef.get(ref), ref);
      // Confused deputy: a draft is code its author wrote. Somebody who runs another person's revision
      // does not hand it their personal credentials (they edit the draft first, which makes them its author).
      if (secret.scope === 'personal' && !(await this.startedByAuthor(run)))
        throw new SecretDenied('secret_scope_not_usable', ref);
      const verdict = devRunSecretVerdict(
        {
          scope: secret.scope as 'personal' | 'team' | 'tenant',
          scopeId: secret.scopeId,
          tenantId: secret.tenantId,
          usage: secret.usage as SecretUsage,
        },
        { agentNodeId: run.tenantId, starterUserId: run.startedBy, policy },
      );
      if (verdict) throw new SecretDenied(verdict, ref);
      this.assertScope(run, chain, secret, ref);
      await this.assertUsable(run, secret, ref, step.destinations);
      out.push({ ref, secret });
    }
    return out;
  }

  /** Whether the user who started a development run wrote the revision it executes. */
  private async startedByAuthor(run: RunRow): Promise<boolean> {
    if (!run.agentRevisionId || !run.startedBy) return false;
    const [rev] = await this.ctx.db
      .select({ authorId: agentDraftRevisions.authorId, kind: agentDraftRevisions.authorKind })
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.id, run.agentRevisionId));
    return rev?.kind === 'user' && rev.authorId === run.startedBy;
  }

  private resolvedSecret(r: Resolved | undefined, ref: string): SecretRow {
    if (!r || r.pin.state !== 'resolved' || !r.secret) {
      const code = r?.pin.state === 'unresolved' ? r.pin.code : 'secret_unavailable';
      throw new SecretDenied(
        code === 'secret_not_found' ? 'secret_not_found' : 'secret_unavailable',
        ref,
      );
    }
    if (stateOf(r.secret, this.ctx.now()) !== 'active')
      throw new SecretDenied('secret_unavailable', ref);
    return r.secret;
  }

  /** The plaintext of a prepared secret, for one issuance. */
  async open(p: PreparedSecret): Promise<string> {
    if (p.secret.backend === 'env') return this.ctx.secrets.resolve(p.secret.pointer!);
    return this.store.open(p.secret);
  }

  /** Remembers the value just issued to a session (sealed), for the redaction of the run. */
  recordIssued(
    run: RunRow,
    session: { id: string; expiresAt: Date },
    p: PreparedSecret,
    value: string,
  ): Promise<void> {
    return this.store.recordIssued(
      this.ctx.db,
      { runId: run.id, sessionId: session.id, expiresAt: session.expiresAt, secret: p.secret },
      value,
    );
  }

  /**
   * Every scoped value issued to a run, for redaction. It covers what was ISSUED, so a rotation, a
   * revocation or a deletion of the secret afterwards does not let the old value into a step record.
   */
  issuedValues(runId: string): Promise<string[]> {
    return this.store.issuedValues(runId);
  }

  private async pinsOf(versionId: string | null): Promise<Map<string, SecretPin>> {
    if (!versionId) return new Map();
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
    // The row must be the secret the REFERENCE names: scope and name are part of the reference.
    const named = parseSecretRef(ref);
    if (
      !secret ||
      secret.tenantId !== pin.ownerNode ||
      named?.kind !== 'scoped' ||
      named.scope !== secret.scope ||
      named.name !== secret.name
    )
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
    // A personal secret is decided by the stage verdicts before this point (production: never;
    // development: only the starter's own); it is attached to no chain.
    if (secret.scope === 'personal') return;
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
