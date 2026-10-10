import type { SecretRegistry } from './secret-registry.js';

/** Where finished log lines go (a pino destination: `write` takes one JSON line). */
export interface LineSink {
  write(line: string): unknown;
}

/**
 * A pino destination that removes registered secret values from each finished log line, whatever
 * field or error text they ended up in. Scrubbing the serialized line (not the log object) also
 * covers `err.message`, stack traces and nested objects without walking them.
 */
export function scrubbingDestination(registry: SecretRegistry, sink: LineSink): LineSink {
  return { write: (line) => sink.write(registry.size === 0 ? line : registry.scrub(line)) };
}
