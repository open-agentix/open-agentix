import { argConstraintIssues } from '../agents/arg-rules.js';
import { pointer } from './manifest-semantic.js';
import type { ManifestFinding } from './manifest-types.js';

/**
 * Static rules for argument constraints and call limits on tool permissions (AEP-0002 sections 7.5.5
 * and 7.5.6, draft). The constraints are read from the core fields `args`, `allowAdditionalArgs` and
 * `maxCalls` (once a pinned schema defines them) or from the extensions `x-openagentix-args`,
 * `x-openagentix-allowAdditionalArgs` and `x-openagentix-maxCallsPerRun`:
 *
 * - `args.with-deny`: `args` or a call limit on an entry with `allow: false`;
 * - `args.pattern-invalid`: a `pattern` or `deny` entry that does not compile, uses a backreference
 *   or lookaround, or repeats a repetition or alternation (the exponential shapes);
 * - `args.pattern-unbounded`: a `pattern` or `deny` without `maxLength` of at most 4096;
 * - `args.type-mismatch`: `pattern`/`minLength`/`maxLength` on a type other than string,
 *   `minimum`/`maximum` on a non-numeric type, `maxItems` on a non-array;
 * - `args.range`: `minimum > maximum` or `minLength > maxLength`;
 * - `args.limit`: more constraints than the validator is willing to check.
 *
 * The validator only reads the patterns; it never runs one against data. Rules apply to every
 * permission entry (`spec.permissions`, `spec.agents[].permissions` of a workflow, `spec.permissions`
 * of an agent).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Argument names per entry and `deny` patterns per argument that are checked. */
export const ARG_LIMITS = { maxArgs: 256, maxDeny: 64 } as const;

const ARGS = ['args', 'x-openagentix-args'] as const;
const CALL_LIMITS = ['maxCalls', 'x-openagentix-maxCallsPerRun'] as const;

function entriesOf(doc: Obj): { path: (string | number)[]; entry: Obj }[] {
  const out: { path: (string | number)[]; entry: Obj }[] = [];
  const spec = doc.spec;
  if (!isObj(spec)) return out;
  const collect = (holder: Obj, base: (string | number)[]): void => {
    const permissions = holder.permissions;
    if (!isObj(permissions) || !isObj(permissions.tools)) return;
    for (const [key, entry] of Object.entries(permissions.tools))
      if (isObj(entry)) out.push({ path: [...base, 'permissions', 'tools', key], entry });
  };
  collect(spec, ['spec']);
  if (Array.isArray(spec.agents))
    spec.agents.forEach((a, i) => {
      if (isObj(a)) collect(a, ['spec', 'agents', i]);
    });
  return out;
}

/** Findings for the argument constraints of a structurally valid manifest. */
export function argFindings(doc: Obj): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const add = (code: string, path: (string | number)[], message: string): void => {
    out.push({ severity: 'error', code, path: pointer(...path), message, section: '7.5.5' });
  };
  for (const { path, entry } of entriesOf(doc)) {
    if (entry.allow === false)
      for (const field of [...ARGS, ...CALL_LIMITS])
        if (entry[field] !== undefined)
          add(
            'args.with-deny',
            [...path, field],
            `"${field}" is only valid on an entry with allow: true`,
          );
    for (const field of ARGS) {
      const args = entry[field];
      if (!isObj(args)) continue;
      const names = Object.keys(args);
      if (names.length > ARG_LIMITS.maxArgs)
        add(
          'args.limit',
          [...path, field],
          `more than ${ARG_LIMITS.maxArgs} constrained arguments`,
        );
      for (const name of names.slice(0, ARG_LIMITS.maxArgs)) {
        const c = args[name];
        if (!isObj(c)) continue; // the schema (or the extension schema) reports a wrong shape
        const deny = Array.isArray(c.deny) ? c.deny : [];
        if (deny.length > ARG_LIMITS.maxDeny)
          add(
            'args.limit',
            [...path, field, name, 'deny'],
            `more than ${ARG_LIMITS.maxDeny} deny patterns`,
          );
        const checked = deny.length > ARG_LIMITS.maxDeny ? { ...c, deny: [] } : c;
        for (const issue of argConstraintIssues(checked))
          add(
            issue.code,
            [
              ...path,
              field,
              name,
              ...(issue.field === ''
                ? []
                : issue.field.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))),
            ],
            issue.message,
          );
      }
    }
  }
  return out;
}
