export interface BundleForm {
  forbiddenTools: string;
  forbiddenArgPatterns: string;
  requireApprovalTools: string;
  maxClassification: string;
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Bundle (API shape) -> form fields (one entry per line, `pattern | reason` for arg patterns). */
export function bundleToForm(bundle: Record<string, unknown>): BundleForm {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join('\n') : '');
  const patterns = Array.isArray(bundle.forbiddenArgPatterns)
    ? bundle.forbiddenArgPatterns
        .map((p) => {
          const o = (p ?? {}) as { pattern?: unknown; reason?: unknown };
          return o.reason ? `${String(o.pattern)} | ${String(o.reason)}` : String(o.pattern);
        })
        .join('\n')
    : '';
  return {
    forbiddenTools: list(bundle.forbiddenTools),
    forbiddenArgPatterns: patterns,
    requireApprovalTools: list(bundle.requireApprovalTools),
    maxClassification: typeof bundle.maxClassification === 'string' ? bundle.maxClassification : '',
  };
}

export function formToBundle(form: BundleForm): Record<string, unknown> {
  const bundle: Record<string, unknown> = {
    forbiddenTools: lines(form.forbiddenTools),
    forbiddenArgPatterns: lines(form.forbiddenArgPatterns).map((l) => {
      const idx = l.lastIndexOf(' | ');
      return idx > 0
        ? { pattern: l.slice(0, idx).trim(), reason: l.slice(idx + 3).trim() }
        : { pattern: l };
    }),
    requireApprovalTools: lines(form.requireApprovalTools),
  };
  if (form.maxClassification) bundle.maxClassification = form.maxClassification;
  return bundle;
}

/** Returns the patterns that are not valid regular expressions. */
export function invalidPatterns(form: BundleForm): string[] {
  return lines(form.forbiddenArgPatterns)
    .map((l) => {
      const idx = l.lastIndexOf(' | ');
      return idx > 0 ? l.slice(0, idx).trim() : l;
    })
    .filter((p) => {
      try {
        new RegExp(p);
        return false;
      } catch {
        return true;
      }
    });
}
