/** Keys that hold secret *references* (names of env vars / Kubernetes secrets), never values. */
const REF_KEYS = /^(envSecrets|headerSecrets|secretRefs?|.*Secret|.*SecretRef|.*Ref)$/;
/** Values that look like real keys even though they sit in a reference field. */
const KEY_LIKE = /^(sk-|sk_|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|ghp_|github_pat_|xox[a-z]-)/;
const SECRETISH = /(secret|token|passw(or)?d|authorization|api[-_]?key|credential)/i;

/** Returns JSON paths that look like inline secret values (they must be references instead). */
export function findInlineSecrets(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findInlineSecrets(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (REF_KEYS.test(k)) {
      if (/Secret$/.test(k) && typeof v === 'string' && KEY_LIKE.test(v)) out.push(p);
      continue;
    }
    if (SECRETISH.test(k) && typeof v === 'string' && v.length > 0) out.push(p);
    else out.push(...findInlineSecrets(v, p));
  }
  return out;
}

/** Names of the secrets a connection references. */
export function secretReferences(config: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const [key, v] of Object.entries(config)) {
    if ((key === 'envSecrets' || key === 'headerSecrets') && v && typeof v === 'object')
      refs.push(...Object.values(v as Record<string, unknown>).map(String));
    // Model connections: apiKeySecret, accessKeyIdSecret, ...
    else if (/Secret$/.test(key) && typeof v === 'string') refs.push(v);
  }
  return refs;
}
