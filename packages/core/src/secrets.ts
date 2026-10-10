import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OaxError } from './errors.js';

/**
 * Secrets are referenced by name (never stored in agent files, prompts or the database).
 * The default resolver reads `OAX_SECRET_<NAME>` from the environment or a file named `<name>`
 * from a mounted directory (e.g. a Kubernetes Secret volume).
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
  /**
   * Whether any secret exists whose canonical name (lower case, every non-alphanumeric character
   * `_`) starts with `canonicalPrefix` (`acme_`). Optional: a backend that cannot list returns
   * nothing here and the operator reserves slugs by configuration instead.
   */
  hasEntriesUnder?(canonicalPrefix: string): Promise<boolean>;
}

const canonical = (ref: string) => ref.toLowerCase().replace(/[^a-z0-9]/g, '_');

const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function envNameForSecret(ref: string): string {
  return `OAX_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export class DefaultSecretResolver implements SecretResolver {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly dir: string | undefined = env.OAX_SECRETS_DIR,
  ) {}

  async resolve(ref: string): Promise<string> {
    if (!REF.test(ref))
      throw new OaxError('secret_ref_invalid', `invalid secret reference "${ref}"`);
    const fromEnv = this.env[envNameForSecret(ref)];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (this.dir) {
      try {
        return (await readFile(join(this.dir, ref), 'utf8')).trim();
      } catch {
        // fall through to the not-found error
      }
    }
    throw new OaxError('secret_not_found', `secret "${ref}" is not configured`);
  }

  async hasEntriesUnder(canonicalPrefix: string): Promise<boolean> {
    const envPrefix = `OAX_SECRET_${canonicalPrefix.toUpperCase()}`;
    if (Object.entries(this.env).some(([k, v]) => k.startsWith(envPrefix) && v)) return true;
    if (!this.dir) return false;
    try {
      return (await readdir(this.dir)).some((f) => canonical(f).startsWith(canonicalPrefix));
    } catch {
      // Fail closed: a directory that cannot be listed may hold anything.
      return true;
    }
  }
}

/** In-memory resolver for tests and the local CLI. */
export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  async resolve(ref: string): Promise<string> {
    const v = this.values[ref];
    if (v === undefined)
      throw new OaxError('secret_not_found', `secret "${ref}" is not configured`);
    return v;
  }

  async hasEntriesUnder(canonicalPrefix: string): Promise<boolean> {
    return Object.keys(this.values).some((k) => canonical(k).startsWith(canonicalPrefix));
  }
}
