/**
 * Which scoped secrets a **development run** (a run of a draft revision, ADR 0017 sections 8 and
 * 13.5) may receive. Pure functions: the api feeds them the secret row, the run and the policy.
 *
 * The rules, in the order they are checked:
 *
 * 1. `allowDraftRuns: off` allows no development run at all.
 * 2. A `personal` secret is usable only by its owner, only when the run was started by the owner,
 *    and only while `allowPersonalSecretsInDevRuns` is on. It never resolves in any other run.
 * 3. A tenant secret owned by ANOTHER node than the agent's own (inherited from an ancestor) is
 *    reachable from a draft only when its owner marked it `usage: development`: a published version
 *    needs an approved review to pin such a secret (`approval_required_for_foreign_secret`), and a
 *    draft has none, so the owner's explicit opt-in stands in for it.
 * 4. Usage: `development` and `any` are issued; `production` is refused unless the policy lets
 *    drafts use production secrets (`allowDraftRuns: on` together with
 *    `allowProductionSecretsInDraftRuns`).
 */
import type { SecretResolutionCode } from './secret-scopes.js';

export type SecretUsage = 'development' | 'production' | 'any';
export type RunStage = 'production' | 'development';

/** The policy keys that decide what a development run may receive (the effective values). */
export interface DevRunSecretPolicy {
  allowDraftRuns: 'off' | 'development-credentials' | 'on';
  allowPersonalSecretsInDevRuns: boolean;
  allowProductionSecretsInDraftRuns: boolean;
}

/** What the verdict needs to know about the secret. */
export interface DevRunSecret {
  scope: 'personal' | 'team' | 'tenant';
  scopeId: string;
  /** The node that owns the secret. */
  tenantId: string;
  usage: SecretUsage;
}

export interface DevRunContext {
  /** The node of the agent the run belongs to. */
  agentNodeId: string;
  /** The user who started the run (always set for a development run). */
  starterUserId: string | null;
  policy: DevRunSecretPolicy;
}

/** Whether a secret with this usage may be used by a run of this stage (`any` is usable in both). */
export function usageAllowsStage(
  usage: SecretUsage,
  stage: RunStage,
  policy?: Pick<DevRunSecretPolicy, 'allowDraftRuns' | 'allowProductionSecretsInDraftRuns'>,
): boolean {
  if (usage === 'any') return true;
  if (stage === 'production') return usage === 'production';
  if (usage === 'development') return true;
  return policy?.allowDraftRuns === 'on' && policy.allowProductionSecretsInDraftRuns === true;
}

/**
 * `null` when the development run may receive the secret, else the stable code of the refusal.
 * It does NOT check that the owner of a personal secret is still entitled to use it (disabled or
 * lost the role): that needs the user's current permissions and is `secret_owner_unavailable`.
 */
export function devRunSecretVerdict(
  secret: DevRunSecret,
  ctx: DevRunContext,
): SecretResolutionCode | null {
  if (ctx.policy.allowDraftRuns === 'off') return 'secret_scope_not_usable';
  if (secret.scope === 'personal') {
    if (!ctx.policy.allowPersonalSecretsInDevRuns) return 'secret_scope_not_usable';
    if (!ctx.starterUserId || secret.scopeId !== ctx.starterUserId)
      return 'secret_scope_not_usable';
  }
  const foreign = secret.scope === 'tenant' && secret.tenantId !== ctx.agentNodeId;
  if (foreign && secret.usage !== 'development') return 'secret_scope_not_usable';
  if (!usageAllowsStage(secret.usage, 'development', ctx.policy)) return 'secret_not_usable';
  return null;
}

/**
 * The verdict for a run of a PUBLISHED version: a personal secret never reaches it (a version cannot
 * carry one, and a personal value is not issued to a production run even if a pin were forged), and
 * a `development` secret is refused.
 */
export function productionRunSecretVerdict(
  secret: Pick<DevRunSecret, 'scope' | 'usage'>,
): SecretResolutionCode | null {
  if (secret.scope === 'personal') return 'secret_scope_not_usable';
  if (!usageAllowsStage(secret.usage, 'production')) return 'secret_not_usable';
  return null;
}
