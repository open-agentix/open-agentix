/**
 * Process-wide set of secret values that are in use right now (OAuth access tokens handed out by
 * `McpCredentials`), consulted by everything that writes text outside the model context: the log
 * stream, audit payloads and HTTP error bodies. It is the "log redactor" of ADR 0016 section 7.5;
 * the per-run `ContextGuard` is the other registration target.
 *
 * Bounded on purpose: a long-running process sees many tokens, and the oldest values are
 * forgotten first. A token lives for minutes to hours, far less than the time it takes to hand
 * out `MAX_KNOWN_SECRETS` newer ones, so the bound only guards memory.
 */
export const MAX_KNOWN_SECRETS = 4096;
const MIN_LENGTH = 8;

export class SecretRegistry {
  private readonly values = new Set<string>();
  private snapshot: readonly string[] = [];

  register(value: string): void {
    if (value.length < MIN_LENGTH || this.values.has(value)) return;
    this.values.add(value);
    if (this.values.size > MAX_KNOWN_SECRETS) {
      const oldest = this.values.values().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.snapshot = [...this.values].sort((a, b) => b.length - a.length);
  }

  /** Longest first, so a secret that contains another one is replaced as a whole. */
  list(): readonly string[] {
    return this.snapshot;
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
    this.snapshot = [];
  }

  /**
   * Replaces every registered value in `text` (plain, URL-encoded and JSON-escaped forms, as they
   * appear in URLs and in serialized log lines and bodies).
   */
  scrub(text: string): string {
    if (this.snapshot.length === 0) return text;
    let out = text;
    for (const secret of this.snapshot) {
      for (const form of new Set([
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
      ])) {
        if (form.length >= MIN_LENGTH && out.includes(form))
          out = out.split(form).join('[REDACTED]');
      }
    }
    return out;
  }
}

/** The registry of this process. Tests that need isolation create their own. */
export const processSecrets = new SecretRegistry();
