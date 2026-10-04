/** Keys that hold secret *references* (names of env vars / Kubernetes secrets), never values. */
const REF_KEYS = /^(envSecrets|headerSecrets|secretRefs?|.*SecretRef|.*Ref)$/;
const SECRETISH = /(secret|token|passw(or)?d|authorization|api[-_]?key|credential)/i;

/** Returns JSON paths that look like inline secret values (they must be references instead). */
export function findInlineSecrets(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findInlineSecrets(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (REF_KEYS.test(k)) continue;
    if (SECRETISH.test(k) && typeof v === 'string' && v.length > 0) out.push(p);
    else out.push(...findInlineSecrets(v, p));
  }
  return out;
}

/** Names of the secrets a connection references. */
export function secretReferences(config: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const key of ['envSecrets', 'headerSecrets']) {
    const v = config[key];
    if (v && typeof v === 'object')
      refs.push(...Object.values(v as Record<string, unknown>).map(String));
  }
  return refs;
}
