import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../canonical.js';

/**
 * Agent lifecycle policy (ADR 0017 section 6): the tenant-owned rules for publishing agents,
 * stored as `settings.agentLifecycle` of a tenant node and resolved down the tenant tree.
 *
 * **Narrowing only.** A node may make the policy stricter than its parent's effective policy and
 * never looser. The root of an organisation is the exception by construction: it has no ancestor,
 * so it chooses its values freely within the allowed domain of each key (the installation defaults
 * are defaults, not bounds). Every other node is compared with the effective policy of its parent;
 * a write that would widen any key is refused (`not_narrowing`), and a stored value that widens
 * anyway (the parent tightened later, or the row was edited by hand) is clamped at resolve time, so
 * the effective policy of a node is never looser than its parent's. The module is pure: no
 * database, no clock.
 *
 * The keys `breakGlass*` and `approverBindingMinAgeHours` do not exist (owner decisions 11 and 18 of
 * 2026-10-10); sending them is an error, not a no-op, so a client cannot believe it set them.
 */

/** Roles a tenant may list as approvers (`allowedApproverRoles`). */
export const APPROVER_ROLES = ['admin', 'agent-maintainer', 'agent-developer', 'operator'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/** Identity sources `approverIdentitySources` may name (`scim` follows with W5-1). */
export const IDENTITY_SOURCES = ['local', 'oidc', 'ldap'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const REQUIRE_APPROVAL_VALUES = ['off', 'production-only', 'on'] as const;
export const APPROVER_SCOPES = ['tenant', 'team', 'other-team'] as const;
export const PUBLISH_BY_VALUES = ['any-publisher', 'approver-only'] as const;
export const DRAFT_RUN_VALUES = ['off', 'development-credentials', 'on'] as const;
export const PERSONAL_SECRET_VALUES = ['never', 'with-approval'] as const;
export const UNSIGNED_CONTRIBUTOR_VALUES = ['declared-non-production', 'refuse'] as const;

/** Largest `minApprovals` and `approvalExpiryHours` (ADR 0017 decisions 3 and 4). */
export const MAX_MIN_APPROVALS = 5;
export const MAX_APPROVAL_EXPIRY_HOURS = 720;
const MAX_USE_CASE_GLOBS = 50;

export interface LifecyclePolicy {
  requireApprovalForPublish: (typeof REQUIRE_APPROVAL_VALUES)[number];
  productionUseCases: string[];
  selfApproval: 'never';
  minApprovals: number;
  allowedApproverRoles: ApproverRole[];
  approverScope: (typeof APPROVER_SCOPES)[number];
  approvalExpiryHours: number;
  allowTokenApprovals: boolean;
  approverIdentitySources: IdentitySource[];
  publishBy: (typeof PUBLISH_BY_VALUES)[number];
  allowDraftRuns: (typeof DRAFT_RUN_VALUES)[number];
  allowPersonalSecretsInDevRuns: boolean;
  allowPersonalSecretsInPublishedAgents: (typeof PERSONAL_SECRET_VALUES)[number];
  allowProductionSecretsInDraftRuns: boolean;
  gitUnsignedContributors: (typeof UNSIGNED_CONTRIBUTOR_VALUES)[number];
}

export type LifecycleKey = keyof LifecyclePolicy;

/** The values a node stores itself: any subset of the keys, sparse. */
export type LifecyclePolicyInput = Partial<LifecyclePolicy>;

/** Defaults of section 6 except `requireApprovalForPublish`, which depends on the installation. */
export const LIFECYCLE_DEFAULTS: Readonly<Omit<LifecyclePolicy, 'requireApprovalForPublish'>> = {
  productionUseCases: [],
  selfApproval: 'never',
  minApprovals: 1,
  allowedApproverRoles: ['admin', 'agent-maintainer'],
  approverScope: 'tenant',
  approvalExpiryHours: 168,
  allowTokenApprovals: false,
  approverIdentitySources: [...IDENTITY_SOURCES],
  publishBy: 'any-publisher',
  allowDraftRuns: 'development-credentials',
  allowPersonalSecretsInDevRuns: true,
  allowPersonalSecretsInPublishedAgents: 'never',
  allowProductionSecretsInDraftRuns: false,
  gitUnsignedContributors: 'refuse',
};

const uniqueEnumList = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .array(z.enum(values))
    .min(1, 'must not be empty')
    .max(values.length)
    .refine((a) => new Set(a).size === a.length, 'must not contain duplicates');

const USE_CASE_GLOB =
  /^[A-Za-z0-9*?][A-Za-z0-9._\-*?]*(\/[A-Za-z0-9*?][A-Za-z0-9._\-*?]*|\/\*\*)*$/;

/** Strict schema of the stored/PATCHed object: unknown keys are errors. */
export const LifecyclePolicyInputSchema = z.strictObject({
  requireApprovalForPublish: z.enum(REQUIRE_APPROVAL_VALUES).optional(),
  productionUseCases: z
    .array(z.string().min(1).max(200).regex(USE_CASE_GLOB, 'invalid use-case glob'))
    .max(MAX_USE_CASE_GLOBS)
    .optional(),
  selfApproval: z.literal('never').optional(),
  minApprovals: z.number().int().min(1).max(MAX_MIN_APPROVALS).optional(),
  allowedApproverRoles: uniqueEnumList(APPROVER_ROLES).optional(),
  approverScope: z.enum(APPROVER_SCOPES).optional(),
  approvalExpiryHours: z.number().int().min(1).max(MAX_APPROVAL_EXPIRY_HOURS).optional(),
  allowTokenApprovals: z.boolean().optional(),
  approverIdentitySources: uniqueEnumList(IDENTITY_SOURCES).optional(),
  publishBy: z.enum(PUBLISH_BY_VALUES).optional(),
  allowDraftRuns: z.enum(DRAFT_RUN_VALUES).optional(),
  allowPersonalSecretsInDevRuns: z.boolean().optional(),
  allowPersonalSecretsInPublishedAgents: z.enum(PERSONAL_SECRET_VALUES).optional(),
  allowProductionSecretsInDraftRuns: z.boolean().optional(),
  gitUnsignedContributors: z.enum(UNSIGNED_CONTRIBUTOR_VALUES).optional(),
});

export interface PolicyIssue {
  path: string;
  message: string;
}

/** Validates a stored or submitted object; never throws. */
export function parseLifecycleInput(
  raw: unknown,
): { ok: true; value: LifecyclePolicyInput } | { ok: false; issues: PolicyIssue[] } {
  const r = LifecyclePolicyInputSchema.safeParse(raw);
  if (r.success) {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.data)) if (v !== undefined) value[k] = v;
    return { ok: true, value: value as LifecyclePolicyInput };
  }
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      path: i.path.join('.'),
      message:
        i.code === 'unrecognized_keys'
          ? `unknown key ${(i as { keys: string[] }).keys.map((k) => `"${k}"`).join(', ')}`
          : i.message,
    })),
  };
}

/** How one key narrows. Values are checked against the zod schema before they get here. */
interface KeySpec {
  /** True when `child` is looser than `parent` (a violation of narrowing). */
  widens(parent: never, child: never): boolean;
  /** The value a child ends up with when it asks for `child` below `parent` (never looser). */
  clamp(parent: never, child: never): unknown;
}

const spec = <T>(widens: (p: T, c: T) => boolean, clamp: (p: T, c: T) => T): KeySpec =>
  ({ widens, clamp }) as unknown as KeySpec;

/** An ordered key; with `strictLast` a later entry is stricter, otherwise an earlier one is. */
const ordered = (order: readonly string[], strictLast: boolean): KeySpec => {
  const strictness = (v: string) => (strictLast ? order.indexOf(v) : -order.indexOf(v));
  return spec<string>(
    (p, c) => strictness(c) < strictness(p),
    (p, c) => (strictness(c) < strictness(p) ? p : c),
  );
};
/** A flag that a child may only switch off. */
const offOnly = (): KeySpec =>
  spec<boolean>(
    (p, c) => c && !p,
    (p, c) => p && c,
  );
/** A set that a child may only shrink, never to empty. */
const narrowSet = (): KeySpec =>
  spec<string[]>(
    (p, c) => !c.every((x) => p.includes(x)),
    (p, c) => {
      const both = p.filter((x) => c.includes(x));
      return both.length > 0 ? both : p;
    },
  );

const SPECS: Record<LifecycleKey, KeySpec> = {
  requireApprovalForPublish: ordered(REQUIRE_APPROVAL_VALUES, true),
  // Union: a child can only add entries, so it can never loosen this key.
  productionUseCases: spec<string[]>(
    () => false,
    (p, c) => [...new Set([...p, ...c])].sort(),
  ),
  selfApproval: spec<string>(
    () => false,
    () => 'never',
  ),
  minApprovals: spec<number>(
    (p, c) => c < p,
    (p, c) => Math.max(p, c),
  ),
  allowedApproverRoles: narrowSet(),
  approverScope: spec<string>(
    (p, c) => p !== 'tenant' && c !== p,
    (p, c) => (p === 'tenant' ? c : p),
  ),
  approvalExpiryHours: spec<number>(
    (p, c) => c > p,
    (p, c) => Math.min(p, c),
  ),
  allowTokenApprovals: offOnly(),
  approverIdentitySources: narrowSet(),
  publishBy: ordered(PUBLISH_BY_VALUES, true),
  allowDraftRuns: ordered(DRAFT_RUN_VALUES, false),
  allowPersonalSecretsInDevRuns: offOnly(),
  allowPersonalSecretsInPublishedAgents: ordered(PERSONAL_SECRET_VALUES, false),
  allowProductionSecretsInDraftRuns: offOnly(),
  gitUnsignedContributors: ordered(UNSIGNED_CONTRIBUTOR_VALUES, true),
};

export const LIFECYCLE_KEYS = Object.keys(SPECS) as LifecycleKey[];

/** Installation defaults, completed with the built-in ones. */
export function lifecycleDefaults(
  installation: Partial<LifecyclePolicy> & Pick<LifecyclePolicy, 'requireApprovalForPublish'>,
): LifecyclePolicy {
  return normalise({ ...LIFECYCLE_DEFAULTS, ...installation });
}

/** Sorted, de-duplicated sets, so equal policies are byte-equal (and digest equal). */
function normalise(p: LifecyclePolicy): LifecyclePolicy {
  const sortedRoles = APPROVER_ROLES.filter((r) => p.allowedApproverRoles.includes(r));
  const sortedSources = IDENTITY_SOURCES.filter((s) => p.approverIdentitySources.includes(s));
  return {
    ...p,
    productionUseCases: [...new Set(p.productionUseCases)].sort(),
    allowedApproverRoles: sortedRoles,
    approverIdentitySources: sortedSources,
  };
}

/**
 * Applies one node's own values on top of its parent's effective policy. `free` takes them as they
 * are (the root of an organisation, and the proposal of a write that is then checked); `clamp`
 * never lets a value be looser than the parent's.
 */
function apply(
  parent: LifecyclePolicy,
  own: LifecyclePolicyInput | undefined,
  mode: 'free' | 'clamp',
): LifecyclePolicy {
  const out: Record<string, unknown> = { ...parent };
  if (own)
    for (const k of LIFECYCLE_KEYS) {
      const v = own[k];
      if (v === undefined) continue;
      const keySpec = SPECS[k];
      out[k] =
        mode === 'clamp' || k === 'productionUseCases'
          ? keySpec.clamp(parent[k] as never, v as never)
          : v;
    }
  return normalise(out as unknown as LifecyclePolicy);
}

/**
 * The effective policy of the last node of `chain` (root first; `undefined` = the node stores
 * nothing). The root's values are taken as they are; every later node is clamped to its parent.
 */
export function resolveLifecyclePolicy(
  defaults: LifecyclePolicy,
  chain: readonly (LifecyclePolicyInput | undefined)[],
): LifecyclePolicy {
  let eff = normalise(defaults);
  chain.forEach((own, i) => {
    eff = apply(eff, own, i === 0 ? 'free' : 'clamp');
  });
  return eff;
}

/**
 * The keys by which `proposed` (the effective policy a write would produce) is looser than the
 * `parent`'s effective policy. Empty = the write is narrowing.
 */
export function wideningKeys(parent: LifecyclePolicy, proposed: LifecyclePolicy): LifecycleKey[] {
  return LIFECYCLE_KEYS.filter((k) =>
    SPECS[k].widens(parent[k] as never, proposed[k] as never),
  );
}

/**
 * The effective policy a node would have if it stored `own` below `parentEffective`, as the write
 * path checks it. For the root (`parentEffective` is the installation default and `isRoot` true)
 * the values are free.
 */
export function proposeLifecyclePolicy(
  parentEffective: LifecyclePolicy,
  own: LifecyclePolicyInput,
): LifecyclePolicy {
  return apply(parentEffective, own, 'free');
}

/** Whether a stricter-than-before change: names the keys whose effective value differs. */
export function changedKeys(from: LifecyclePolicy, to: LifecyclePolicy): LifecycleKey[] {
  return LIFECYCLE_KEYS.filter((k) => canonicalJson(from[k]) !== canonicalJson(to[k]));
}

/**
 * Digest of a policy snapshot (effective tenant policy plus the matching agent rules, section 4.2):
 * SHA-256 of the canonical JSON with a domain tag and a version, over normalised sets, so two
 * equal snapshots always have the same digest and nothing else shares it. `rules` is empty until
 * agent rules exist (slice S8); it is sorted by `name` then canonical form for stability.
 */
export function lifecyclePolicyDigest(
  policy: LifecyclePolicy,
  rules: readonly unknown[] = [],
): string {
  const sortedRules = rules.map((r) => canonicalJson(r)).sort();
  return sha256Hex(
    canonicalJson({
      kind: 'oax.agent-lifecycle-policy',
      v: 1,
      policy: normalise(policy),
      rules: sortedRules,
    }),
  );
}
