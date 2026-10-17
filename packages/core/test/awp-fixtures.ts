import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  exportAwpManifest,
  expandProfiles,
  parseAgentDefinition,
  type AccessCatalog,
  type ExportOptions,
  type ExportResult,
  type PublishedDefinition,
} from '../src/index.js';

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

/** Every agents.md example, as a path relative to `examples/`. */
export function exampleFiles(): string[] {
  const list = (dir: string, match: RegExp) =>
    readdirSync(EXAMPLES_DIR + dir)
      .filter((f) => match.test(f))
      .map((f) => `${dir}${f}`);
  return [
    ...list('', /\.agents\.md$/),
    ...list('agents/', /\.md$/),
    ...list('awp/', /\.agents\.md$/),
  ].sort();
}

export const readExample = (file: string): string => readFileSync(EXAMPLES_DIR + file, 'utf8');

/**
 * Connections of the example agents, with the reviewed tool lists a publish would see. The data is
 * shared with the conformance harness (`scripts/awp/conformance.mjs`).
 */
export const EXAMPLE_CATALOG = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../awp/conformance/example-catalog.json', import.meta.url)),
    'utf8',
  ),
) as AccessCatalog;

/** The parsed file, as `agents.md` validation leaves it (no publish context yet). */
export const parsedOf = (source: string): PublishedDefinition => parseAgentDefinition(source);

/** The stored form of a published definition (what the control node keeps per version). */
export function definitionOf(source: string): PublishedDefinition {
  const { definition, errors } = expandProfiles(parseAgentDefinition(source), EXAMPLE_CATALOG);
  if (errors.length > 0) throw new Error(`publish would be refused: ${JSON.stringify(errors)}`);
  return definition;
}

export function exportOf(
  def: PublishedDefinition,
  extra: Partial<ExportOptions> = {},
): ExportResult {
  return exportAwpManifest(def, { ownerTeam: def.owner, ...extra });
}

type Obj = Record<string, unknown>;

/** A minimal exportable agent (one tool grant without critical fields), patched per test. */
export function probe(
  patch: (o: Obj & { agents: Obj[] }) => void = () => undefined,
): PublishedDefinition {
  const o = {
    apiVersion: 'openagentix.io/v1alpha1',
    kind: 'Agent',
    name: 'probe',
    version: '1.0.0',
    owner: 'team-a',
    agents: [
      {
        id: 'a',
        provider: 'simulated',
        model: 'sim-1',
        instructions: 'Do it.',
        tools: [{ server: 'srv', tool: 'do_it', allowAdditionalArgs: true }],
      },
    ] as Obj[],
  };
  patch(o);
  return parseAgentDefinition(`---\n${stringify(o)}---\n`);
}

/** Walks a JSON value and calls `visit` for every object member. */
export function walk(value: unknown, visit: (key: string, v: unknown, parent: Obj) => void): void {
  if (Array.isArray(value)) for (const v of value) walk(v, visit);
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value as Obj)) {
      visit(k, v, value as Obj);
      walk(v, visit);
    }
}
