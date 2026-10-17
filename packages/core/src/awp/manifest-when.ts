import { parseWhen, WhenError, type WhenNode } from '../agents/when.js';
import { pointer } from './manifest-semantic.js';
import type { ManifestFinding } from './manifest-types.js';

/**
 * Static rules for step conditions (AEP-0001 section 3.10, draft). The condition is read from the core
 * field `when` (once a pinned schema defines it) or from the extension `x-openagentix-when`:
 *
 * - `when.syntax` / `when.limits`: the text must parse in the AEP grammar within its limits;
 * - `when.unknown-step` / `when.not-a-dependency`: `steps.<id>` must be a direct or transitive
 *   dependency of the step (the rule of spec 3.9 for expressions);
 * - `when.undeclared-output`: `<name>` must be a declared output of that step;
 * - `when.undeclared-input` (warning): `inputs.<name>` should be declared.
 *
 * The validator only parses; it never evaluates, so a hostile condition costs a bounded parse.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const FIELDS = ['when', 'x-openagentix-when'] as const;

function pathsOf(node: WhenNode, out: Extract<WhenNode, { type: 'path' }>[] = []) {
  switch (node.type) {
    case 'path':
      out.push(node);
      break;
    case 'exists':
      out.push(node.path);
      break;
    case 'not':
      pathsOf(node.operand, out);
      break;
    case 'and':
    case 'or':
    case 'compare':
      pathsOf(node.left, out);
      pathsOf(node.right, out);
      break;
    default:
      break;
  }
  return out;
}

/** Findings for the conditions of a structurally valid `Workflow` manifest. */
export function whenFindings(doc: Obj): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const spec = doc.spec;
  if (doc.kind !== 'Workflow' || !isObj(spec) || !Array.isArray(spec.workflow)) return out;
  const steps = spec.workflow.filter(isObj);
  const byId = new Map(steps.map((s) => [String(s.id), s]));
  const inputs = new Set(
    (Array.isArray(spec.inputs) ? spec.inputs : []).filter(isObj).map((i) => String(i.name)),
  );
  const closure = (id: string): Set<string> => {
    const seen = new Set<string>();
    const todo = strings(byId.get(id)?.dependsOn);
    while (todo.length > 0) {
      const d = todo.pop() as string;
      if (seen.has(d)) continue;
      seen.add(d);
      todo.push(...strings(byId.get(d)?.dependsOn));
    }
    return seen;
  };
  const finding = (
    severity: 'error' | 'warning',
    code: string,
    path: string,
    message: string,
  ): void => {
    out.push({ severity, code, path, message, section: '3.10' });
  };

  spec.workflow.forEach((raw, index) => {
    if (!isObj(raw)) return;
    for (const field of FIELDS) {
      const text = raw[field];
      if (typeof text !== 'string') continue;
      const at = pointer('spec', 'workflow', index, field);
      let node: WhenNode;
      try {
        node = parseWhen(text, 'awp');
      } catch (e) {
        if (!(e instanceof WhenError)) throw e;
        finding('error', e.limit ? 'when.limits' : 'when.syntax', at, e.message);
        continue;
      }
      const own = String(raw.id);
      const dependencies = closure(own);
      for (const p of pathsOf(node)) {
        if (p.root === 'input') {
          if (!inputs.has(p.name as string))
            finding(
              'warning',
              'when.undeclared-input',
              at,
              `condition reads undeclared input "${p.name}"`,
            );
        } else if (p.root === 'step') {
          const id = p.step as string;
          const target = byId.get(id);
          if (!target)
            finding('error', 'when.unknown-step', at, `condition reads non-existent step "${id}"`);
          else if (!dependencies.has(id))
            finding(
              'error',
              'when.not-a-dependency',
              at,
              `step "${own}" reads steps.${id} but does not depend on it (directly or transitively)`,
            );
          else if (
            !(Array.isArray(target.outputs) ? target.outputs : [])
              .filter(isObj)
              .some((o) => o.name === p.name)
          )
            finding(
              'error',
              'when.undeclared-output',
              at,
              `step "${id}" does not declare output "${p.name}"`,
            );
        }
      }
    }
  });
  return out;
}
