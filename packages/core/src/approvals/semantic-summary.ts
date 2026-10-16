import { effectiveBudget, type AgentDefinition } from '../agents/parser.js';
import type { PublishedDefinition } from '../agents/profiles.js';
import type { Budget } from '../agents/schema.js';

/**
 * The semantic summary of an agent definition (ADR 0017 section 9): what a reviewer must look at
 * besides the text diff, namely tools and their access class, egress, secret references, budget,
 * classification, runtime and owner. It is a pure function of a parsed definition (with its profile
 * expansion), so it cannot disagree with what the run would use. Values never appear: secret
 * references are names only.
 */

export type ToolAccessClass = 'read' | 'write' | 'unclassified';

export interface ToolFact {
  /** `server/tool` (the tool may end in `*`). */
  key: string;
  server: string;
  tool: string;
  /** From the connection catalog; `unclassified` when the catalog does not know the tool. */
  access: ToolAccessClass;
  approval: 'none' | 'required';
  maxCallsPerRun: number | null;
  classification: string | null;
  /** `server:profile` when the grant comes from a profile expansion, otherwise `null`. */
  profile: string | null;
  steps: string[];
}

export interface SecretReferenceFact {
  /** The reference as written in the definition. */
  name: string;
  /**
   * `legacy` for an unprefixed reference (operator environment, tenant prefix): the only kind there
   * is until the scoped secret store exists (ADR 0017 S4). Scope and owning node follow with it.
   */
  scope: 'legacy';
  /** The node that owns the secret; `null` until the scoped secret store exists. */
  ownerNode: string | null;
  env: string | null;
  steps: string[];
}

export interface SemanticFacts {
  name: string;
  version: string;
  owner: string;
  classification: string;
  useCase: string | null;
  runtime: { runner: string; toolbox: string | null };
  /** Hosts the pipeline may reach, including per-step narrowing. */
  egress: string[];
  budget: Record<string, number | null>;
  stepBudgets: Record<string, Record<string, number | null>>;
  tools: ToolFact[];
  secretReferences: SecretReferenceFact[];
  steps: { id: string; provider: string; model: string; access: string | null }[];
}

const BUDGET_KEYS = [
  'maxTokens',
  'maxCostUsd',
  'maxSteps',
  'maxToolCalls',
  'timeoutSeconds',
] as const;

function budgetOf(b: Budget): Record<string, number | null> {
  return Object.fromEntries(BUDGET_KEYS.map((k) => [k, b[k] ?? null]));
}

const byKey = <T extends { key: string }>(a: T, b: T) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

function toolFacts(expanded: PublishedDefinition, declared: AgentDefinition | undefined) {
  const facts = new Map<string, ToolFact>();
  const declaredKeys = new Map(
    (declared?.agents ?? []).map((a) => [
      a.id,
      new Set(a.tools.map((t) => `${t.server}/${t.tool}`)),
    ]),
  );
  const profileOf = new Map<string, string>();
  for (const e of expanded.expansion ?? [])
    for (const t of e.tools)
      profileOf.set(`${e.agentId}\u0000${e.server}/${t}`, `${e.server}:${e.profile}`);
  for (const a of expanded.agents)
    for (const t of a.tools) {
      const key = `${t.server}/${t.tool}`;
      const own = declaredKeys.get(a.id)?.has(key) ?? false;
      const profile = own ? null : (profileOf.get(`${a.id}\u0000${key}`) ?? null);
      const known = expanded.toolAccess?.[key];
      const fact = facts.get(key) ?? {
        key,
        server: t.server,
        tool: t.tool,
        access: known ?? 'unclassified',
        approval: t.approval,
        maxCallsPerRun: t.maxCallsPerRun ?? null,
        classification: t.classification ?? null,
        profile,
        steps: [],
      };
      // One tool in several steps: the strictest approval shows, the steps are listed.
      if (t.approval === 'required') fact.approval = 'required';
      fact.steps.push(a.id);
      facts.set(key, fact);
    }
  return [...facts.values()]
    .sort(byKey)
    .map((f) => ({ ...f, steps: [...new Set(f.steps)].sort() }));
}

function secretFacts(def: PublishedDefinition): SecretReferenceFact[] {
  const out = new Map<string, SecretReferenceFact>();
  for (const a of def.agents)
    for (const c of a.credentials ?? []) {
      const fact = out.get(c.secret) ?? {
        name: c.secret,
        scope: 'legacy' as const,
        ownerNode: null,
        env: c.env ?? null,
        steps: [],
      };
      fact.steps.push(a.id);
      out.set(c.secret, fact);
    }
  return [...out.values()]
    .map((f) => ({ ...f, steps: [...new Set(f.steps)].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The facts of a definition; `declared` (before profile expansion) tells profile grants apart. */
export function summariseDefinition(
  expanded: PublishedDefinition,
  declared?: AgentDefinition,
): SemanticFacts {
  const egress = new Set(expanded.runtime.egress);
  for (const a of expanded.agents) for (const h of a.runtime?.egress ?? []) egress.add(h);
  return {
    name: expanded.name,
    version: expanded.version,
    owner: expanded.owner,
    classification: expanded.classification,
    useCase: expanded.labels.useCase ?? null,
    runtime: { runner: expanded.runtime.runner, toolbox: expanded.runtime.toolbox ?? null },
    egress: [...egress].sort(),
    budget: budgetOf(expanded.budget),
    stepBudgets: Object.fromEntries(
      expanded.agents.map((a) => [a.id, budgetOf(effectiveBudget(expanded.budget, a.budget))]),
    ),
    tools: toolFacts(expanded, declared),
    secretReferences: secretFacts(expanded),
    steps: expanded.agents.map((a) => ({
      id: a.id,
      provider: a.provider,
      model: a.model,
      access: a.access ?? null,
    })),
  };
}

export interface SetChange<T> {
  added: T[];
  removed: T[];
}

export interface ScalarChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

export interface SemanticChanges {
  tools: SetChange<ToolFact> & { changed: { from: ToolFact; to: ToolFact }[] };
  egress: SetChange<string>;
  secretReferences: SetChange<SecretReferenceFact>;
  scalars: ScalarChange[];
}

function diffSet<T>(from: readonly T[], to: readonly T[], key: (x: T) => string): SetChange<T> {
  const a = new Map(from.map((x) => [key(x), x]));
  const b = new Map(to.map((x) => [key(x), x]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, v]) => v),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, v]) => v),
  };
}

const toolSignature = (t: ToolFact) =>
  JSON.stringify([t.access, t.approval, t.maxCallsPerRun, t.classification, t.profile]);

function scalarsOf(f: SemanticFacts): Record<string, string | number | null> {
  return {
    owner: f.owner,
    classification: f.classification,
    useCase: f.useCase,
    'runtime.runner': f.runtime.runner,
    'runtime.toolbox': f.runtime.toolbox,
    ...Object.fromEntries(Object.entries(f.budget).map(([k, v]) => [`budget.${k}`, v])),
  };
}

/** What changed from the base facts to the head facts; with no base everything in head is added. */
export function diffSummaries(from: SemanticFacts | null, to: SemanticFacts): SemanticChanges {
  const tools = diffSet(from?.tools ?? [], to.tools, (t) => t.key);
  const before = new Map((from?.tools ?? []).map((t) => [t.key, t]));
  const changed = to.tools
    .filter((t) => before.has(t.key) && toolSignature(before.get(t.key)!) !== toolSignature(t))
    .map((t) => ({ from: before.get(t.key)!, to: t }));
  const a = from ? scalarsOf(from) : {};
  const b = scalarsOf(to);
  const scalars = Object.keys(b)
    .filter((k) => from && a[k] !== b[k])
    .map((field) => ({ field, from: a[field] ?? null, to: b[field] ?? null }));
  return {
    tools: { ...tools, changed },
    egress: diffSet(from?.egress ?? [], to.egress, (h) => h),
    secretReferences: diffSet(from?.secretReferences ?? [], to.secretReferences, (s) => s.name),
    scalars,
  };
}
