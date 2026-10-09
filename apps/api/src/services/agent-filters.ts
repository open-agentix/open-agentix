import { and, eq, ilike, isNotNull, isNull, like, ne, or, type SQL } from 'drizzle-orm';
import { agentVersions, agents } from '../db/schema.js';

/**
 * Lifecycle status of an agent in the console:
 * - `draft`: never published,
 * - `published`: the draft is identical to the latest published version,
 * - `changed`: the draft differs from the latest published version,
 * - `disabled`: switched off (UX slice A7); it wins over the three above, which only describe
 *   enabled agents.
 */
export const AGENT_STATUSES = ['draft', 'published', 'changed', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Separator of sub-use cases: `support/billing` is a child of `support` (ADR 0013 section 7.2). */
const USE_CASE_SEPARATOR = '/';

/** Escapes `%`, `_` and `\` so user input is matched literally by LIKE / ILIKE. */
export function escapeLike(input: string): string {
  return input.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * Status as a SQL condition. Expects `agent_versions` left-joined on `agents.latest_version_id`.
 * The draft is compared byte for byte with the source of the latest version: a cosmetic edit counts
 * as `changed` until it is published or reverted (documented gap, see docs/ux).
 */
export function statusFilter(status: AgentStatus): SQL {
  const hasVersion = isNotNull(agentVersions.id);
  const enabled = isNull(agents.disabledAt);
  switch (status) {
    case 'draft':
      return and(enabled, isNull(agents.latestVersionId))!;
    case 'published':
      return and(enabled, hasVersion, eq(agentVersions.source, agents.draftSource))!;
    case 'changed':
      return and(enabled, hasVersion, ne(agentVersions.source, agents.draftSource))!;
    case 'disabled':
      return isNotNull(agents.disabledAt);
  }
}

/**
 * Use case filter: the use case itself or any sub-use case (prefix match per path segment, so
 * `support` matches `support` and `support/billing` but not `supported`).
 */
export function useCaseFilter(useCase: string): SQL {
  const base = useCase.replace(/\/+$/, '');
  return or(
    eq(agents.useCase, base),
    like(agents.useCase, `${escapeLike(base)}${USE_CASE_SEPARATOR}%`),
  )!;
}

/** Case-insensitive substring search over name, description and use case. */
export function textFilter(q: string): SQL {
  const pattern = `%${escapeLike(q)}%`;
  return or(
    ilike(agents.name, pattern),
    ilike(agents.description, pattern),
    ilike(agents.useCase, pattern),
  )!;
}
