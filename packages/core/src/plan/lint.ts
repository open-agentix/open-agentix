import { parseWhen, whenStepRefs } from '../agents/when.js';
import {
  parseCapability,
  planDigest,
  type AgentPlan,
  type Capability,
  type PlanStep,
} from './schema.js';

/** Bumped whenever a rule, a severity or a message template changes. */
export const LINT_VERSION = 1;

export const LINT_CODES = [
  'LP001',
  'LP002',
  'LP003',
  'LP004',
  'LP005',
  'LP006',
  'LP007',
  'LP008',
] as const;
export type LintCode = (typeof LINT_CODES)[number];

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface PlanFinding {
  code: LintCode | 'MODEL';
  severity: FindingSeverity;
  /** Dotted path into the plan, e.g. `steps.2.capabilities.0`; `plan` for plan-wide notes. */
  path: string;
  message: string;
  source: 'lint' | 'model';
}

export interface AgentPlanLint {
  kind: 'AgentPlanLint';
  lintVersion: number;
  planDigest: string;
  findings: PlanFinding[];
  summary: { error: number; warning: number; info: number };
}

export type AccessClass = 'read' | 'write';

/**
 * What an MCP connection offers, reduced to names and access classes (never secrets and never
 * tool descriptions, which are untrusted text). Without `tools`/`profiles` the connection is
 * treated as "not declared": profiles `read` and `write` by convention, every tool as `write`.
 */
export interface OfferedConnection {
  name: string;
  tools?: Readonly<Record<string, AccessClass>>;
  profiles?: Readonly<Record<string, readonly string[]>>;
}

export type Resolution =
  { ok: true; access: AccessClass } | { ok: false; reason: 'connection' | 'profile' | 'tool' };

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toolAccess(conn: OfferedConnection, tool: string): AccessClass {
  // A tool without a declared access class counts as write (fail closed).
  return conn.tools?.[tool] ?? 'write';
}

/**
 * Access class of one capability against the offered connections. With `offered === undefined`
 * nothing is verified (offline use): profile `read` is read, every other profile and every tool
 * counts as write.
 */
export function resolveCapability(
  cap: Exclude<Capability, { kind: 'model' }>,
  offered: readonly OfferedConnection[] | undefined,
): Resolution {
  if (offered === undefined) {
    return {
      ok: true,
      access: cap.kind === 'profile' && cap.profile === 'read' ? 'read' : 'write',
    };
  }
  const conn = offered.find((c) => c.name === cap.server);
  if (!conn) return { ok: false, reason: 'connection' };
  if (cap.kind === 'profile') {
    if (conn.profiles) {
      const tools = conn.profiles[cap.profile];
      if (!tools) return { ok: false, reason: 'profile' };
      return {
        ok: true,
        access: tools.some((t) => toolAccess(conn, t) === 'write') ? 'write' : 'read',
      };
    }
    if (cap.profile === 'read' || cap.profile === 'write') return { ok: true, access: cap.profile };
    return { ok: false, reason: 'profile' };
  }
  if (conn.tools) {
    const names = Object.keys(conn.tools);
    const prefix = cap.tool.slice(0, -1);
    const matched = cap.wildcard
      ? names.filter((n) => n.startsWith(prefix))
      : names.filter((n) => n === cap.tool);
    if (matched.length === 0) return { ok: false, reason: 'tool' };
    return {
      ok: true,
      access: matched.some((n) => conn.tools?.[n] === 'write') ? 'write' : 'read',
    };
  }
  return { ok: true, access: 'write' };
}

const NOT_OFFERED = {
  connection: (cap: string, server: string) =>
    `capability ${cap} is not offered: connection "${server}" is not available`,
  profile: (cap: string, server: string) =>
    `capability ${cap} is not offered: connection "${server}" has no such profile`,
  tool: (cap: string, server: string) =>
    `capability ${cap} is not offered: connection "${server}" has no such tool`,
} as const;

/** Natural order: numeric path segments compare as numbers, so `steps.2` sorts before `steps.10`. */
export function comparePaths(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i] as string;
    const q = y[i] as string;
    if (p === q) continue;
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    return numeric ? Number(p) - Number(q) : compareText(p, q);
  }
  return x.length - y.length;
}

export function summarize(findings: readonly PlanFinding[]): AgentPlanLint['summary'] {
  const summary = { error: 0, warning: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return summary;
}

interface Ctx {
  plan: AgentPlan;
  offered: readonly OfferedConnection[] | undefined;
  findings: PlanFinding[];
}

const add = (
  ctx: Ctx,
  code: LintCode,
  severity: 'error' | 'warning',
  path: string,
  message: string,
): void => {
  ctx.findings.push({ code, severity, path, message, source: 'lint' });
};

function lintCapabilities(ctx: Ctx, step: PlanStep, i: number): void {
  const reads = new Set<string>();
  const writes = new Set<string>();
  step.capabilities.forEach((text, j) => {
    const cap = parseCapability(text);
    if (!cap || cap.kind === 'model') return;
    const path = `steps.${i}.capabilities.${j}`;
    if (cap.kind === 'tool' && cap.wildcard) {
      add(ctx, 'LP008', 'warning', path, `wildcard capability ${text} grants every matching tool`);
    }
    const res = resolveCapability(cap, ctx.offered);
    if (!res.ok) {
      add(ctx, 'LP004', 'error', path, NOT_OFFERED[res.reason](text, cap.server));
      return;
    }
    if (res.access === 'read') {
      reads.add(cap.server);
      return;
    }
    writes.add(cap.server);
    if (step.approval !== 'required') {
      add(ctx, 'LP001', 'warning', path, `write capability ${text} without approval`);
    }
    if (step.access === 'read-only') {
      add(ctx, 'LP006', 'error', path, `access is read-only but capability ${text} can write`);
    }
  });
  const path = `steps.${i}.capabilities`;
  const readList = [...reads].sort(compareText);
  const writeList = [...writes].sort(compareText);
  if (readList.some((r) => writeList.some((w) => w !== r))) {
    add(
      ctx,
      'LP002',
      'warning',
      path,
      `step reads system(s) ${readList.join(', ')} and writes system(s) ${writeList.join(', ')}`,
    );
  }
  if (writeList.length > 1) {
    add(
      ctx,
      'LP003',
      'warning',
      path,
      `step holds write capabilities of ${writeList.length} systems: ${writeList.join(', ')}`,
    );
  }
}

function lintReferences(ctx: Ctx): void {
  const index = new Map(ctx.plan.steps.map((s, i) => [s.id, i]));
  const consumers = new Map<string, Set<string>>();
  const check = (ref: string, i: number, path: string, what: 'from' | 'when'): void => {
    const target = index.get(ref);
    if (target === undefined) {
      add(ctx, 'LP007', 'error', path, `"${what}" references unknown step "${ref}"`);
    } else if (target >= i) {
      add(
        ctx,
        'LP007',
        'error',
        path,
        `"${what}" references step "${ref}" which does not run before this step`,
      );
    } else {
      const set = consumers.get(ref) ?? new Set<string>();
      set.add(ctx.plan.steps[i]?.id ?? '');
      consumers.set(ref, set);
    }
  };
  ctx.plan.steps.forEach((step, i) => {
    step.input?.from?.forEach((ref, k) => {
      if (ref !== 'event') check(ref, i, `steps.${i}.input.from.${k}`, 'from');
    });
    if (step.when !== undefined) {
      let refs: string[] | null = null;
      try {
        refs = whenStepRefs(parseWhen(step.when));
      } catch {
        add(ctx, 'LP007', 'error', `steps.${i}.when`, '"when" condition is not valid');
      }
      for (const ref of refs ?? []) check(ref, i, `steps.${i}.when`, 'when');
    }
  });
  for (const [producer, users] of consumers) {
    const p = index.get(producer);
    if (p !== undefined && !ctx.plan.steps[p]?.output) {
      add(
        ctx,
        'LP005',
        'warning',
        `steps.${p}.output`,
        `output of step "${producer}" is used by later step(s) ${[...users].sort(compareText).join(', ')} but has no output schema`,
      );
    }
  }
}

/**
 * Deterministic least-privilege lint (ADR 0008 section 4): a pure function of the plan, the
 * offered connections and {@link LINT_VERSION}. Free text (`description`, `purpose`) is never read,
 * and messages are fixed templates filled with validated identifiers only, so nothing a plan says
 * about itself can change a result. Findings only ever warn; they grant nothing.
 */
export function lintPlan(plan: AgentPlan, offered?: readonly OfferedConnection[]): AgentPlanLint {
  const ctx: Ctx = { plan, offered, findings: [] };
  plan.steps.forEach((step, i) => lintCapabilities(ctx, step, i));
  lintReferences(ctx);
  const findings = ctx.findings.sort(
    (a, b) =>
      comparePaths(a.path, b.path) ||
      compareText(a.code, b.code) ||
      compareText(a.message, b.message),
  );
  return {
    kind: 'AgentPlanLint',
    lintVersion: LINT_VERSION,
    planDigest: planDigest(plan),
    findings,
    summary: summarize(findings),
  };
}
