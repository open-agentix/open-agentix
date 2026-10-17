import { isCollection, isScalar, parseAllDocuments, visit } from 'yaml';
import { normalizeSource, parseMarkdownSections } from '../agents/parser.js';
import { pointer } from './manifest-semantic.js';
import { AWP_LIMITS, type ManifestFinding, type ManifestLayout } from './manifest-types.js';

/**
 * Reads an AWP manifest from text, treating the text as untrusted input (docs/awp.md):
 *
 * - size limit before anything is parsed;
 * - YAML 1.2 core schema, unique keys, no custom tags, no non-string keys (spec 3.1); JSON is parsed
 *   by the same YAML parser, so a JSON and a YAML form of one manifest take the same path;
 * - at most one document; aliases are counted with their expansion (billion-laughs guard);
 * - node count, nesting depth and cycles are checked on the parsed value, before the value is used;
 * - no function of the value is called and nothing is evaluated.
 */

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const AGENT_SECTION = /^agent:\s*(.+?)\s*$/i;
/** `apiVersion: awp.…` as a line of YAML or a member of a JSON object (used only to decide applicability). */
const AWP_API_HINT = /(?:^|[\s{,])["']?apiVersion["']?\s*:\s*["']?awp\./m;

export const AWP_API_VERSION_PREFIX = 'awp.';

/** True for the `apiVersion` of an AWP manifest (any AWP API version). */
export function isAwpApiVersion(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(AWP_API_VERSION_PREFIX);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const finding = (code: string, path: string, message: string, section = ''): ManifestFinding => ({
  severity: 'error',
  code,
  path,
  message,
  section,
});

export interface ParsedManifest {
  layout: ManifestLayout;
  /** Markdown after the front matter (layout `markdown`), otherwise null. */
  body: string | null;
  /** Findings that belong to the source, not to one document (size, empty, too many documents). */
  findings: ManifestFinding[];
  /** One entry per YAML document; a document with an error has no value. */
  documents: ParsedDocument[];
}

/** Why a text is not treated as AWP when the layout is `auto`. */
export type ParseOutcome = ParsedManifest | null;

const firstLine = (message: string): string => message.split('\n')[0] ?? message;

interface ParsedDocument {
  /** The parsed value; undefined when the document has an error. */
  value: unknown;
  findings: ManifestFinding[];
}

function yamlDocuments(text: string, maxDocuments: number): ParsedDocument[] | ManifestFinding {
  let docs;
  try {
    docs = parseAllDocuments(text, { version: '1.2', schema: 'core', uniqueKeys: true });
  } catch (e) {
    return finding('yaml.parse-error', '', firstLine((e as Error).message), '3.1');
  }
  if (docs.length === 0) return finding('yaml.empty', '', 'no document found', '3.1');
  if (docs.length > maxDocuments)
    return finding(
      'limit.documents',
      '',
      `the source has ${docs.length} YAML documents (limit ${maxDocuments})`,
      '3.1',
    );
  return docs.map((doc): ParsedDocument => {
    const findings: ManifestFinding[] = [];
    for (const e of doc.errors)
      findings.push(finding('yaml.parse-error', '', firstLine(e.message), '3.1'));
    for (const w of doc.warnings) {
      findings.push(
        finding(
          /tag/i.test(w.message) ? 'yaml.custom-tag' : 'yaml.warning',
          '',
          firstLine(w.message),
          '3.1',
        ),
      );
    }
    visit(doc, {
      Pair(_, pair) {
        const k = pair.key;
        if (isCollection(k) || (isScalar(k) && typeof k.value !== 'string'))
          findings.push(finding('yaml.non-string-key', '', 'mapping keys MUST be strings', '3.1'));
      },
    });
    if (findings.length > 0) return { value: undefined, findings };
    try {
      return { value: doc.toJS({ maxAliasCount: AWP_LIMITS.maxAliasCount }) as unknown, findings };
    } catch (e) {
      const message = firstLine((e as Error).message);
      const alias = /alias/i.test(message);
      findings.push(
        finding(
          alias ? 'limit.aliases' : 'yaml.parse-error',
          '',
          alias
            ? `too many YAML aliases or an alias expansion that is too large (limit ${AWP_LIMITS.maxAliasCount})`
            : message,
          '3.1',
        ),
      );
      return { value: undefined, findings };
    }
  });
}

/**
 * Walks the parsed value once and rejects what has no JSON equivalent or exceeds the limits:
 * cycles through aliases (spec 3.1), more than `maxNodes` nodes, nesting deeper than `maxDepth`,
 * non-finite numbers, integers beyond 2^53 (they would silently change the digest).
 */
export function inspectValue(
  root: unknown,
  budget: { nodes: number } = { nodes: AWP_LIMITS.maxNodes },
): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const onPath = new Set<object>();
  type Frame = { node: object; keys: string[]; next: number; path: (string | number)[] };
  const frames: Frame[] = [];
  const reported = new Set<string>();
  const once = (code: string, path: string, message: string): void => {
    if (!reported.has(code)) {
      reported.add(code);
      out.push(finding(code, path, message, '3.1'));
    }
  };

  const enter = (value: unknown, path: (string | number)[]): boolean => {
    budget.nodes -= 1;
    if (budget.nodes < 0) {
      once('limit.nodes', '', `the document has more than ${AWP_LIMITS.maxNodes} nodes`);
      return false;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        once(
          'yaml.non-json-value',
          pointer(...path),
          'non-finite numbers (.inf, .nan) have no JSON form',
        );
      else if (Number.isInteger(value) && !Number.isSafeInteger(value))
        once(
          'yaml.unsafe-integer',
          pointer(...path),
          'integers beyond 2^53 cannot be represented exactly',
        );
      return true;
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol')
        once('yaml.non-json-value', pointer(...path), 'value has no JSON form');
      return true;
    }
    if (onPath.has(value)) {
      once('yaml.cycle', pointer(...path), 'anchors that create cycles are not allowed');
      return false;
    }
    if (frames.length >= AWP_LIMITS.maxDepth) {
      once('limit.depth', pointer(...path), `nesting is deeper than ${AWP_LIMITS.maxDepth} levels`);
      return false;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      once('yaml.non-json-value', pointer(...path), 'value has no JSON form');
      return false;
    }
    onPath.add(value);
    frames.push({
      node: value,
      keys: Array.isArray(value) ? [] : Object.keys(value),
      next: 0,
      path,
    });
    return true;
  };

  if (!enter(root, [])) return out;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const size = Array.isArray(frame.node) ? frame.node.length : frame.keys.length;
    if (frame.next >= size) {
      onPath.delete(frame.node);
      frames.pop();
      continue;
    }
    const index = frame.next++;
    const key = Array.isArray(frame.node) ? index : frame.keys[index]!;
    const child = Array.isArray(frame.node)
      ? (frame.node as unknown[])[index]
      : (frame.node as Record<string, unknown>)[key as string];
    if (!enter(child, [...frame.path, key]) && reported.has('limit.nodes')) break;
  }
  return out;
}

function locate(
  source: string,
  layout: 'auto' | ManifestLayout,
): { layout: ManifestLayout; text: string; body: string | null } | { error: ManifestFinding } {
  const normalized = normalizeSource(source);
  if (layout === 'document') return { layout: 'document', text: normalized, body: null };
  const match = FRONT_MATTER.exec(normalized);
  if (layout === 'markdown') {
    if (!match)
      return {
        error: finding(
          'wrapper.no-front-matter',
          '',
          'an agents.md file must start with a YAML front matter block (---)',
        ),
      };
    return { layout: 'markdown', text: match[1] ?? '', body: normalized.slice(match[0].length) };
  }
  if (normalized.trimStart().startsWith('{'))
    return { layout: 'document', text: normalized, body: null };
  if (match)
    return { layout: 'markdown', text: match[1] ?? '', body: normalized.slice(match[0].length) };
  return { layout: 'document', text: normalized, body: null };
}

/**
 * Parses the text. With `layout: 'auto'` a text that is not an AWP manifest (no `apiVersion: awp.…`)
 * yields `null`, so the caller can hand it to another parser; with an explicit layout the text is
 * always treated as AWP and errors are findings. A plain document may hold several YAML documents
 * (spec 3.1, each is an independent manifest); the front matter of an `agents.md` is exactly one.
 */
export function parseManifestSource(
  source: string,
  layout: 'auto' | ManifestLayout = 'auto',
): ParseOutcome {
  const sourceLevel = (l: ManifestLayout, f: ManifestFinding): ParsedManifest => ({
    layout: l,
    body: null,
    findings: [f],
    documents: [],
  });
  if (Buffer.byteLength(source, 'utf8') > AWP_LIMITS.maxSourceBytes) {
    return sourceLevel(
      layout === 'markdown' ? 'markdown' : 'document',
      finding('limit.size', '', `the source is larger than ${AWP_LIMITS.maxSourceBytes} bytes`),
    );
  }
  const located = locate(source, layout);
  if ('error' in located) return sourceLevel('markdown', located.error);
  let documents: ParsedDocument[];
  try {
    const parsed = yamlDocuments(
      located.text,
      located.layout === 'markdown' ? 1 : AWP_LIMITS.maxDocuments,
    );
    if (!Array.isArray(parsed)) {
      if (layout === 'auto' && !AWP_API_HINT.test(located.text)) return null;
      return sourceLevel(located.layout, parsed);
    }
    documents = parsed;
  } catch (e) {
    // The parser is recursive: absurdly deep input surfaces as a RangeError, never as a crash.
    if (!(e instanceof RangeError)) throw e;
    if (layout === 'auto' && !AWP_API_HINT.test(located.text)) return null;
    return sourceLevel(
      located.layout,
      finding('limit.depth', '', 'the document is nested too deeply', '3.1'),
    );
  }
  if (located.layout === 'markdown' && documents.length > 1) {
    return sourceLevel(
      'markdown',
      finding(
        'yaml.multiple-documents',
        '',
        'the front matter must be exactly one YAML document',
        '3.1',
      ),
    );
  }
  if (layout === 'auto') {
    const first = documents[0]!;
    const applies =
      first.value !== undefined
        ? isObj(first.value) && isAwpApiVersion(first.value.apiVersion)
        : AWP_API_HINT.test(located.text);
    if (!applies) return null;
  }
  const budget = { nodes: AWP_LIMITS.maxNodes };
  for (const d of documents) {
    if (d.value === undefined) continue;
    d.findings.push(...inspectValue(d.value, budget));
    if (d.findings.some((f) => f.severity === 'error')) d.value = undefined;
  }
  return { layout: located.layout, body: located.body, findings: [], documents };
}

/**
 * Builds the effective manifest of an `agents.md` file: the front matter with the text of each
 * `## Agent: <id>` section as `instructions` of the inline agent `<id>` (trimmed, line endings
 * normalised). Title, overview and other sections are documentation and not part of the manifest.
 * Conflicts are findings, never silently resolved: a section and `instructions`/`promptRef` of the
 * same agent, a section of a reference or remote agent, a duplicate section, a section without agent.
 * Mutates `value` (a fresh parse result) and returns the findings.
 */
export function injectAgentSections(value: unknown, body: string): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const sections = new Map<string, string>();
  for (const s of parseMarkdownSections(body).sections) {
    const m = AGENT_SECTION.exec(s.heading);
    if (!m) continue;
    const id = m[1]!;
    if (sections.has(id)) {
      out.push(
        finding('wrapper.duplicate-section', '/spec/agents', `two sections "## Agent: ${id}"`),
      );
      continue;
    }
    sections.set(id, s.body);
  }
  if (sections.size === 0) return out;
  const agents =
    isObj(value) &&
    value.kind === 'Workflow' &&
    isObj(value.spec) &&
    Array.isArray(value.spec.agents)
      ? (value.spec.agents as unknown[])
      : [];
  const used = new Set<string>();
  agents.forEach((entry, i) => {
    if (!isObj(entry) || typeof entry.id !== 'string' || !sections.has(entry.id)) return;
    const text = sections.get(entry.id)!;
    used.add(entry.id);
    const at = pointer('spec', 'agents', i);
    if ('ref' in entry || 'protocol' in entry) {
      out.push(
        finding(
          'wrapper.section-not-inline',
          at,
          `section "## Agent: ${entry.id}" belongs to an inline agent; this one is a reference or remote agent`,
        ),
      );
    } else if ('instructions' in entry || 'promptRef' in entry) {
      out.push(
        finding(
          'wrapper.instructions-conflict',
          `${at}/${'instructions' in entry ? 'instructions' : 'promptRef'}`,
          `agent "${entry.id}" has a section "## Agent: ${entry.id}" and also sets instructions or promptRef in the front matter`,
        ),
      );
    } else if (text === '') {
      out.push(
        finding(
          'wrapper.empty-section',
          `${at}/instructions`,
          `section "## Agent: ${entry.id}" is empty`,
        ),
      );
    } else {
      entry.instructions = text;
    }
  });
  for (const id of sections.keys()) {
    if (!used.has(id))
      out.push(
        finding(
          'wrapper.section-orphan',
          '/spec/agents',
          `section "## Agent: ${id}" has no inline agent "${id}" in spec.agents`,
        ),
      );
  }
  return out;
}
