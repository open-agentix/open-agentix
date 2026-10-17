import { toAwpWhen } from './when-awp.js';
import {
  EXTENSION_PREFIX,
  type ExportFinding,
  type ExportFindingCode,
  type JsonObject,
  type JsonValue,
} from './types.js';

/**
 * Critical extension fields (docs/awp.md): a runtime that ignores one would allow more than the
 * `agents.md` source allows. Key = source field, value = extension name.
 */
export const CRITICAL_EXTENSIONS = {
  when: `${EXTENSION_PREFIX}when`,
  input: `${EXTENSION_PREFIX}input`,
  output: `${EXTENSION_PREFIX}output`,
  schemas: `${EXTENSION_PREFIX}schemas`,
  access: `${EXTENSION_PREFIX}access`,
  args: `${EXTENSION_PREFIX}args`,
  allowAdditionalArgs: `${EXTENSION_PREFIX}allowAdditionalArgs`,
  maxCallsPerRun: `${EXTENSION_PREFIX}maxCallsPerRun`,
  classification: `${EXTENSION_PREFIX}classification`,
  'runtime.runner': `${EXTENSION_PREFIX}runtime`,
  'runtime.toolbox': `${EXTENSION_PREFIX}runtime`,
  guidelines: `${EXTENSION_PREFIX}guidelines`,
} as const;
export type CriticalField = keyof typeof CRITICAL_EXTENSIONS;

interface CriticalUse {
  field: CriticalField;
  path: string;
}

/**
 * Collects what an export run learns: findings (refusals) and the
 * critical extensions it had to write. Nothing is dropped silently: whatever cannot be carried is
 * a finding.
 */
export class ExportContext {
  readonly findings: ExportFinding[] = [];
  private readonly uses: CriticalUse[] = [];

  /**
   * @param stepWhen the pinned schema defines the core step field `when` (AEP-0001).
   * @param toolArgs the pinned schema defines `args`, `allowAdditionalArgs` and `maxCalls` on a
   *   tool permission (AEP-0002).
   */
  constructor(
    private readonly stepWhen = false,
    readonly toolArgs = false,
  ) {
    // Writes happen through the methods below.
  }

  refuse(code: ExportFindingCode, path: string, message: string): void {
    this.findings.push({ code, path, message });
  }

  /** Writes a critical extension on `target` and records it for the refusal / required list. */
  critical(target: JsonObject, field: CriticalField, path: string, value: JsonValue): void {
    this.uses.push({ field, path });
    target[CRITICAL_EXTENSIONS[field]] = value;
  }

  /**
   * Writes the condition of a step in the AEP-0001 grammar: as the core field `when` when the pinned
   * schema has it, otherwise as the critical extension `x-openagentix-when`. A condition that cannot
   * be mapped refuses the export; it is never dropped and never written with another meaning.
   */
  condition(target: JsonObject, source: string, path: string, hasEvent: boolean): void {
    const mapped = toAwpWhen(source, hasEvent);
    if (!mapped.ok) {
      this.refuse('condition_not_representable', path, mapped.reason);
      return;
    }
    if (this.stepWhen) target.when = mapped.expression;
    else this.critical(target, 'when', path, mapped.expression);
  }

  /** Records a critical extension that is merged into an object written elsewhere. */
  noteCritical(field: CriticalField, path: string): void {
    this.uses.push({ field, path });
  }

  /** D3: one finding per critical source field while the pin has no `requiredExtensions`. */
  criticalFindings(): ExportFinding[] {
    return this.uses.map(({ field, path }) => ({
      code: 'critical_extension',
      path,
      field,
      extension: CRITICAL_EXTENSIONS[field],
      message:
        `"${field}" has no AWP v1alpha1 equivalent and ${CRITICAL_EXTENSIONS[field]} cannot be ` +
        'declared as required in the pinned AWP version; a runtime that ignores it would allow ' +
        'more than the agents.md source',
    }));
  }

  /** Sorted, unique extension names for `metadata.requiredExtensions` (AEP-0011). */
  requiredExtensions(): string[] {
    return [...new Set(this.uses.map((u) => CRITICAL_EXTENSIONS[u.field]))].sort();
  }
}

/** Refuses fields the exporter does not know: a field it cannot map must not vanish silently. */
export function rejectUnknownKeys(
  ctx: ExportContext,
  value: object,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key))
      ctx.refuse(
        'unknown_field',
        path ? `${path}.${key}` : key,
        `field "${key}" is not known to the exporter and would be dropped`,
      );
  }
}
