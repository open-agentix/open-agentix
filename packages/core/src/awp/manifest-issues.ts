import type { ValidationIssue } from '../errors.js';
import type { ManifestValidation } from './manifest-types.js';

/**
 * The findings of an AWP validation as the issues of `agents.md` validation (`path`, `message`,
 * `code`), for the API and the CLI. `path` is the JSON Pointer of the AWP rule catalogue and `code`
 * the AWP diagnostic code; a message of a source with several documents names the document.
 */
export function manifestIssues(v: ManifestValidation): {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const several = v.documents.length > 1;
  for (const f of v.findings) {
    const issue: ValidationIssue = {
      path: f.path,
      code: f.code,
      message: several ? `[document ${(f.document ?? 0) + 1}] ${f.message}` : f.message,
    };
    (f.severity === 'error' ? errors : warnings).push(issue);
  }
  return { errors, warnings };
}
