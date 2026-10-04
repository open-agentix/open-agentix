import { parseDocument } from 'yaml';
import { sha256Hex } from '../canonical.js';
import { ValidationError, type ValidationIssue } from '../errors.js';
import {
  PipelineFrontMatterSchema,
  isProfileGrant,
  type AgentSpecSchema,
  type Budget,
  type PipelineFrontMatter,
  type ProfileGrant,
  type ToolGrant,
} from './schema.js';
import type { z } from 'zod';

export type AgentSpec = Omit<z.infer<typeof AgentSpecSchema>, 'tools'> & {
  instructions: string;
  /** Concrete tool grants (what the policy engine evaluates). */
  tools: ToolGrant[];
  /**
   * Profile grants (`tools[].profile`), only present when the file declares some. Expanded into
   * `tools` at publish (ADR 0008); definitions stored before 0.2 never carry this field.
   */
  profileGrants?: ProfileGrant[];
};

/** A parsed, structurally valid `agents.md` document. */
export interface AgentDefinition extends Omit<PipelineFrontMatter, 'agents' | 'pipeline'> {
  agents: AgentSpec[];
  /** Execution order (agent ids). */
  pipeline: string[];
  /** Markdown text between the title and the first agent section. */
  overview: string;
  /** All `## ` sections that are not agent sections, keyed by heading. */
  sections: Record<string, string>;
  /** SHA-256 of the normalised source; identifies an immutable published version. */
  digest: string;
}

export interface MarkdownSections {
  title: string | null;
  overview: string;
  sections: { heading: string; body: string }[];
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const AGENT_HEADING = /^agent:\s*([a-z][a-z0-9-]*)\s*$/i;

/** Normalises line endings and trailing whitespace so digests are stable across platforms. */
export function normalizeSource(source: string): string {
  return (
    source
      .replace(/\r\n?/g, '\n')
      .replace(/^\uFEFF/, '')
      .trimEnd() + '\n'
  );
}

export function splitFrontMatter(source: string): { frontMatter: string; body: string } {
  const normalized = normalizeSource(source);
  const match = FRONT_MATTER.exec(normalized);
  if (!match) {
    throw new ValidationError('agents.md must start with a YAML front matter block (---)', [
      { path: '', message: 'missing front matter' },
    ]);
  }
  return { frontMatter: match[1] ?? '', body: normalized.slice(match[0].length) };
}

/** Splits markdown into an optional `# title`, an overview and `## ` sections (code fences aware). */
export function parseMarkdownSections(body: string): MarkdownSections {
  const lines = body.split('\n');
  let title: string | null = null;
  const overview: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    if (!inFence && /^# /.test(line) && title === null && sections.length === 0) {
      title = line.slice(2).trim();
      continue;
    }
    if (!inFence && /^## /.test(line)) {
      sections.push({ heading: line.slice(3).trim(), body: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current) current.body.push(line);
    else overview.push(line);
  }
  return {
    title,
    overview: overview.join('\n').trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })),
  };
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/**
 * Parses an `agents.md` document: YAML front matter (schema-checked) plus markdown sections.
 * Agent instructions come from `## Agent: <id>` sections (or the inline `instructions` field).
 * Throws {@link ValidationError} with all structural issues. Semantic checks live in `validate.ts`.
 */
export function parseAgentDefinition(source: string): AgentDefinition {
  const { frontMatter, body } = splitFrontMatter(source);
  const doc = parseDocument(frontMatter, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ValidationError(
      'invalid YAML front matter',
      doc.errors.map((e) => ({ path: '', message: e.message })),
    );
  }
  const raw: unknown = doc.toJS({ maxAliasCount: 50 });
  const parsed = PipelineFrontMatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ValidationError('invalid agents.md front matter', zodIssues(parsed.error));
  }
  const fm = parsed.data;
  const md = parseMarkdownSections(body);
  const agentSections = new Map<string, string>();
  const sections: Record<string, string> = {};
  for (const s of md.sections) {
    const m = AGENT_HEADING.exec(s.heading);
    if (m?.[1]) agentSections.set(m[1].toLowerCase(), s.body);
    else sections[s.heading] = s.body;
  }
  const issues: ValidationIssue[] = [];
  const agents: AgentSpec[] = fm.agents.map((a, i) => {
    const instructions = (agentSections.get(a.id) ?? a.instructions ?? '').trim();
    if (!instructions) {
      issues.push({
        path: `agents.${i}.instructions`,
        message: `agent "${a.id}" needs instructions (section "## Agent: ${a.id}" or field "instructions")`,
      });
    }
    const tools: ToolGrant[] = [];
    const profileGrants: ProfileGrant[] = [];
    for (const t of a.tools) {
      if (isProfileGrant(t)) profileGrants.push(t);
      else tools.push(t);
    }
    return profileGrants.length > 0
      ? { ...a, instructions, tools, profileGrants }
      : { ...a, instructions, tools };
  });
  for (const id of agentSections.keys()) {
    if (!fm.agents.some((a) => a.id === id)) {
      issues.push({
        path: 'body',
        message: `section "Agent: ${id}" has no matching agent in front matter`,
      });
    }
  }
  if (issues.length > 0) throw new ValidationError('invalid agents.md', issues);
  const { agents: _agents, pipeline, ...rest } = fm;
  return {
    ...rest,
    agents,
    pipeline: pipeline ?? fm.agents.map((a) => a.id),
    overview: md.overview,
    sections,
    digest: sha256Hex(normalizeSource(source)),
  };
}

/** Pipeline budget merged with an agent budget (the stricter value wins per field). */
export function effectiveBudget(pipeline: Budget, agent?: Budget): Budget {
  const out: Budget = { ...pipeline };
  if (!agent) return out;
  for (const key of Object.keys(agent) as (keyof Budget)[]) {
    const a = agent[key];
    const p = pipeline[key];
    if (a !== undefined) out[key] = p === undefined ? a : Math.min(a, p);
  }
  return out;
}
