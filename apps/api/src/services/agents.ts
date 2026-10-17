import { randomUUID } from 'node:crypto';
import { assertWithinCeiling, parseEgressEntry } from '@openagentix/runners';
import {
  checkPublish,
  expandProfiles,
  hasPermission,
  hasPermissionIn,
  legacyDeprecation,
  legacyFormatPhase,
  legacyRemovedMessage,
  LEGACY_REMOVED_CODE,
  loadAgentDefinition,
  manifestIssues,
  stripInvisible,
  useCaseCovers,
  useCaseScopes,
  validateAgentSource,
  validateManifestSource,
  visibleAgents,
  visibleTeams,
  summariseDecisions,
  type AgentDefinition,
  type Deprecation,
  type DecisionFact,
  type LegacyPhase,
  type PublishedDefinition,
  type Principal,
  type ValidationIssue,
  type ValidationResult,
} from '@openagentix/core';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  agentReviewDecisions,
  agentReviews,
  agentVersionAwp,
  agentVersions,
  agents,
  teams,
} from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { decodeTimeCursor, encodeTimeCursor, page } from '../pagination.js';
import { statusFilter, textFilter, useCaseFilter, type AgentStatus } from './agent-filters.js';
import {
  appendRevision,
  authorOf,
  ensureHead,
  firstRevision,
  lockAgent,
  type RevisionRow,
} from './agent-revisions.js';
import type { ShadowReport } from './agent-reviews.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';
import type { ResolvedScope } from './subtree-scope.js';
import {
  awpRowOf,
  convertDefinition,
  storeConversion,
  teamLookup,
  type StoredAwpRow,
} from './legacy-awp.js';
import { useCaseMatch } from './use-case-scope.js';
import { VERSION } from '../version.js';

/**
 * Outcome of validating a source without storing it: an `agents.md` file (`format: 'agents-md'`)
 * or an AWP manifest (`format: 'awp'`, AWP-3). For an AWP manifest `errors`/`warnings` carry the AWP
 * diagnostic `code` and the JSON Pointer `path`, `digest` is the AWP manifest digest, `manifest` the
 * effective manifest, and `definition` is null: an AWP manifest is validated, not stored or run yet.
 */
export interface SourceValidation {
  format: 'agents-md' | 'awp';
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  name: string | null;
  version: string | null;
  digest: string | null;
  definition: AgentDefinition | null;
  manifest: Record<string, unknown> | null;
  /** `legacy_format` once per legacy `agents.md` source (AWP-3b); empty for an AWP manifest. */
  deprecations: Deprecation[];
}

/** Longest reason accepted when an agent is disabled or enabled. */
export const MAX_DISABLE_REASON_LENGTH = 500;

/**
 * Normalises a free-text disable/enable reason before it is stored, audited and shown: invisible
 * and bidi Unicode and control characters are removed (they could hide or reorder text in the
 * console and the audit export, and NUL is rejected by PostgreSQL), and line breaks, tabs and runs
 * of whitespace become one space, so the reason stays a single line. Empty results become null.
 */
export function cleanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return stripInvisible(reason).text.replace(/\s+/gu, ' ').trim() || null;
}

export type AgentRow = typeof agents.$inferSelect;
export type AgentVersionRow = typeof agentVersions.$inferSelect;

export interface VersionSummary {
  id: string;
  agentId: string;
  version: string;
  digest: string;
  publishedBy: string | null;
  publishedAt: Date;
}

const summary = (v: AgentVersionRow): VersionSummary => ({
  id: v.id,
  agentId: v.agentId,
  version: v.version,
  digest: v.digest,
  publishedBy: v.publishedBy,
  publishedAt: v.publishedAt,
});

const IMMUTABLE_TTL = 3_600_000;

/** Reports what publish would have been refused for (ADR 0017 S1, set once the services exist). */
export type ShadowPublish = (agent: AgentRow, source: string) => Promise<ShadowReport>;

/** Filters of {@link AgentsService.list}; all of them narrow the principal's visible agents. */
export interface AgentListQuery {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  teamId?: string | undefined;
  useCase?: string | undefined;
  status?: AgentStatus | undefined;
}

/**
 * The use case an agent is attributed to (cost attribution and budgets use the same label). An
 * empty label counts as none, as in the backfill of migration 0015.
 */
const useCaseOf = (def: AgentDefinition): string | null => def.labels.useCase || null;

/** Agent registry: drafts, validation, immutable published versions. */
export class AgentsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  /** Wired by `createServices`: the shadow-mode check of publish (ADR 0017 S1). */
  shadowPublish: ShadowPublish | undefined;

  /**
   * AWP-3b: release N (`deprecated`) or N+1 (`removed`) of the legacy file format. Derived from the
   * version of this build by a constant (`LEGACY_FORMAT_REMOVED_IN`), not from configuration; the
   * field exists so that the N+1 behaviour can be tested without building another release.
   */
  legacyPhase: LegacyPhase = legacyFormatPhase(VERSION);

  /** Release N+1: the legacy format is refused on every write path, naming `oax awp convert`. */
  assertLegacyWritable(): void {
    if (this.legacyPhase === 'removed')
      throw new HttpError(400, LEGACY_REMOVED_CODE, legacyRemovedMessage());
  }

  /**
   * A read of a stored legacy agent, version or manifest: the one `legacy_format` deprecation on every
   * read, and the audit event `agent.legacy_format_read` once per principal, agent, surface (and
   * version) and day. Every audit append takes the global audit lock, so a console that polls an
   * agent must not write a row per request; the cache entry (shared with Valkey when configured) is
   * the dedupe window, and every read is counted in `oax_legacy_format_reads_total`.
   */
  async legacyRead(
    principal: Principal,
    agent: AgentRow,
    surface: 'agent' | 'version' | 'awp-export',
    version?: string,
  ): Promise<Deprecation[]> {
    const deprecation = legacyDeprecation();
    this.ctx.metrics.legacyFormatReads.inc({ surface });
    const day = this.ctx.now().toISOString().slice(0, 10);
    const key = `legacy-read:${principal.userId}:${agent.id}:${surface}:${version ?? ''}:${day}`;
    if (!(await this.ctx.cache.get<boolean>(key))) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: agent.tenantId,
        action: 'agent.legacy_format_read',
        target: agent.id,
        payload: { surface, ...(version ? { version } : {}), removedIn: deprecation.removedIn },
      });
      await this.ctx.cache.set(key, true, 24 * 3_600_000);
    }
    return [deprecation];
  }

  /**
   * Release N+1: a version is not run unless it has a stored AWP conversion. A version without a row
   * (the one-time conversion has not reached it yet) is converted on demand and refused when the
   * conversion is refused, so the gate never fails open. Always false in release N.
   */
  async legacyRunRefused(versionId: string): Promise<boolean> {
    if (this.legacyPhase !== 'removed') return false;
    const stored = await awpRowOf(this.ctx.db, versionId);
    if (stored) return stored.status === 'legacy-unconvertible';
    const [row] = await this.ctx.db
      .select({ v: agentVersions, a: agents })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .where(eq(agentVersions.id, versionId));
    if (!row) return false; // the caller reports the missing version
    const c = await convertDefinition(
      row.a,
      row.v.definition as PublishedDefinition,
      teamLookup(this.ctx.db, row.a.tenantId),
    );
    return c.status !== 'converted';
  }

  async teamIdForOwner(tenantId: string, owner: string): Promise<string | null> {
    const [t] = await this.ctx.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.slug, owner), eq(teams.tenantId, tenantId)));
    return t?.id ?? null;
  }

  /**
   * Resource-level check incl. agent-scoped bindings. Principals that cannot even read the agent
   * get 404 (existence is not revealed) and the denial is audited.
   */
  async assertAccess(
    principal: Principal,
    agent: AgentRow,
    permission:
      | 'agents:read'
      | 'agents:write'
      | 'agents:publish'
      | 'agents:review'
      | 'agents:approve'
      | 'runs:execute',
  ): Promise<void> {
    // Tenant boundary first: another tenant's agent does not exist for this principal. An agent
    // carries a use case, so a use-case binding of that use case (or a parent use case) counts too.
    const ref = { teamId: agent.teamId, agentId: agent.id, useCase: agent.useCase };
    if (agent.tenantId === principal.tenantId) {
      if (hasPermissionIn(principal, permission, ref)) return;
    }
    if (agent.tenantId !== principal.tenantId || !hasPermissionIn(principal, 'agents:read', ref)) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'access.denied',
        target: agent.id,
        payload: { permission, resource: 'agent' },
      });
      throw notFound('agent');
    }
    throw forbidden();
  }

  /**
   * An agent written or published under a use-case binding cannot be relabelled out of the use
   * case: it would land in another use case, where its administrators never chose it. Callers who
   * hold the permission node-wide, for the team or for the agent are not limited by the label.
   */
  private assertLabelInScope(
    principal: Principal,
    permission: 'agents:write' | 'agents:publish',
    agent: AgentRow,
    next: string | null,
  ): void {
    const own = hasPermission(principal, permission, agent.teamId, agent.id);
    // Relabelling an agent into another use case hands its runs and costs to the administrators of
    // that use case: node-level authority, or the administrator of the target use case (for an agent
    // of a team who also holds the permission for the team). A team writer or a writer bound to this
    // agent alone cannot do it.
    if (
      next !== null &&
      next !== agent.useCase &&
      !hasPermission(principal, permission, null) &&
      !(
        useCaseScopes(principal, permission).some((s) => useCaseCovers(s, next)) &&
        (own || agent.teamId === null)
      )
    )
      throw forbidden('relabelling the use case of an agent needs node-level authority');
    if (own) return;
    // A use-case binding writes agents without a team only.
    if (
      agent.teamId === null &&
      useCaseScopes(principal, permission).some((s) => useCaseCovers(s, next))
    )
      return;
    throw forbidden('the use case of the agent is outside your scope');
  }

  /**
   * Validates an `agents.md` source or an AWP manifest (front matter with `apiVersion: awp.…`, or a
   * plain JSON/YAML document). An AWP manifest is checked offline against the pinned schema and
   * rules; it needs no connection catalog and reads no tenant data, so it cannot disclose any.
   */
  async validateSource(principal: Principal, source: string): Promise<SourceValidation> {
    const awp = validateManifestSource(source);
    if (awp) {
      const { errors, warnings } = manifestIssues(awp);
      return {
        format: 'awp',
        valid: awp.valid,
        errors,
        warnings,
        name: awp.name,
        version: awp.version,
        digest: awp.valid ? awp.digest : null,
        definition: null,
        manifest: awp.valid ? (awp.manifest as unknown as Record<string, unknown>) : null,
        deprecations: [],
      };
    }
    const r = await this.validateFor(principal, source);
    if (this.legacyPhase === 'removed')
      return {
        format: 'agents-md',
        valid: false,
        errors: [
          { path: 'apiVersion', code: LEGACY_REMOVED_CODE, message: legacyRemovedMessage() },
        ],
        warnings: [],
        name: null,
        version: null,
        digest: null,
        definition: null,
        manifest: null,
        deprecations: [],
      };
    return {
      format: 'agents-md',
      valid: r.valid,
      errors: r.errors,
      warnings: r.warnings,
      name: r.definition?.name ?? null,
      version: r.definition?.version ?? null,
      digest: r.definition?.digest ?? null,
      definition: r.definition,
      manifest: null,
      deprecations: [legacyDeprecation()],
    };
  }

  validate(source: string): ValidationResult {
    return validateAgentSource(source);
  }

  /**
   * Like {@link validate}, plus the checks that need the connection catalog: unknown connections
   * and profiles, and write tools for `access: read-only` steps (the same checks publish makes).
   */
  async validateFor(principal: Principal, source: string): Promise<ValidationResult> {
    const result = validateAgentSource(source);
    if (!result.definition) return result;
    // The connections a team may use are that team's business: a caller who holds the agent
    // permissions through a use case only is checked against the connections of the whole tenant,
    // never against those of a team it names (it would be an oracle for the team's connections).
    const named = await this.teamIdForOwner(principal.tenantId, result.definition.owner);
    const teamId =
      named !== null &&
      !hasPermission(principal, 'agents:read', named) &&
      useCaseScopes(principal, 'agents:read').length > 0
        ? null
        : named;
    const catalog = await this.catalog.accessCatalog({
      tenantId: principal.tenantId,
      teamId,
      agentId: '',
    });
    const { errors } = expandProfiles(result.definition, catalog);
    const stdio = await this.catalog.stdioIsolationIssues(result.definition, {
      tenantId: principal.tenantId,
      teamId,
      agentId: '',
    });
    const all = [...errors, ...stdio.map(({ path, message }) => ({ path, message }))];
    // ADR 0016 S2 lint: MCP hosts that a step still lists in runtime.egress (advisory).
    const unused = await this.catalog.egressUnused(result.definition, {
      tenantId: principal.tenantId,
      teamId,
      agentId: '',
    });
    const withLint =
      unused.length > 0 ? { ...result, warnings: [...result.warnings, ...unused] } : result;
    if (all.length === 0) return withLint;
    return {
      ...withLint,
      valid: false,
      definition: null,
      errors: [...result.errors, ...all],
    };
  }

  /** `opts.id` fixes the agent id (deterministic demo seed); random when omitted. */
  async create(
    principal: Principal,
    source: string,
    opts: { id?: string } = {},
  ): Promise<AgentRow> {
    this.assertLegacyWritable();
    const def = loadAgentDefinition(source);
    const teamId = await this.teamIdForOwner(principal.tenantId, def.owner);
    if (!hasPermission(principal, 'agents:write', teamId)) {
      // A use-case writer creates agents of its use case that belong to no team: a team brings its
      // connections with it, and those are not part of a use case (ADR 0014 section 3.3).
      const inScope = useCaseScopes(principal, 'agents:write').some((s) =>
        useCaseCovers(s, useCaseOf(def)),
      );
      if (!(teamId === null && inScope))
        throw forbidden(
          teamId === null
            ? 'the use case of the agent is outside your scope'
            : `no write access for team "${def.owner}"`,
        );
    }
    const [exists] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.name, def.name), eq(agents.tenantId, principal.tenantId)));
    if (exists) throw conflict(`agent "${def.name}" already exists`);
    const row = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [created] = await tx
        .insert(agents)
        .values({
          id: opts.id ?? randomUUID(),
          tenantId: principal.tenantId,
          name: def.name,
          teamId,
          description: def.description ?? null,
          useCase: useCaseOf(def),
          draftSource: source,
          createdBy: principal.userId,
        })
        .returning();
      // The first revision of the draft, with its author (ADR 0017 section 4.1).
      const revision = await firstRevision(tx, created!, source, authorOf(principal.userId));
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.created',
          target: created!.id,
          payload: { name: def.name, version: def.version, digest: def.digest },
        },
        tx,
      );
      await this.auditRevision(tx, created!, revision, principal.userId);
      return { ...created!, draftRevisionId: revision.id };
    });
    return row;
  }

  private auditRevision(tx: Db, agent: AgentRow, revision: RevisionRow, actor: string) {
    return this.audit.append(
      {
        actor,
        tenantId: agent.tenantId,
        action: 'agent.revision.created',
        target: agent.id,
        payload: {
          revision: revision.id,
          seq: revision.seq,
          digest: revision.digest,
          author: revision.authorId,
        },
      },
      tx,
    );
  }

  /**
   * Loads an agent. Pass the caller's tenant for every request-facing lookup: an agent of another
   * tenant is then "not found" (and the attempt is audited in the caller's tenant). Only trusted
   * internal callers (worker, scheduler) omit it.
   */
  async get(
    id: string,
    tenant?: Pick<Principal, 'tenantId' | 'userId'> | string,
  ): Promise<AgentRow> {
    const [row] = await this.ctx.db.select().from(agents).where(eq(agents.id, id));
    const tenantId = typeof tenant === 'string' ? tenant : tenant?.tenantId;
    if (!row) throw notFound('agent');
    if (tenantId && row.tenantId !== tenantId) {
      await this.audit.append({
        actor: typeof tenant === 'object' ? tenant.userId : 'unknown',
        tenantId,
        action: 'access.denied',
        target: id,
        payload: { permission: 'agents:read', resource: 'agent' },
      });
      throw notFound('agent');
    }
    return row;
  }

  /**
   * The row filter for the agents the principal may read: the acting tenant with team and
   * agent-scoped bindings applied, or, for `scope=subtree`, the resolved predicate over the visible
   * nodes. `undefined` when nothing is readable.
   */
  private visibility(principal: Principal, subtree: ResolvedScope | undefined): SQL | undefined {
    if (subtree)
      return subtree.isEmpty
        ? undefined
        : subtree.predicate({
            tenantId: agents.tenantId,
            teamId: agents.teamId,
            agent: agents.id,
            useCase: agents.useCase,
          });
    const teamsVisible = visibleTeams(principal, 'agents:read');
    const agentsVisible = visibleAgents(principal, 'agents:read');
    const useCases = useCaseScopes(principal, 'agents:read');
    if (
      Array.isArray(teamsVisible) &&
      teamsVisible.length === 0 &&
      agentsVisible.length === 0 &&
      useCases.length === 0
    )
      return undefined;
    return and(
      eq(agents.tenantId, principal.tenantId),
      teamsVisible === 'all'
        ? undefined
        : or(
            teamsVisible.length ? inArray(agents.teamId, teamsVisible) : undefined,
            agentsVisible.length ? inArray(agents.id, agentsVisible) : undefined,
            useCases.length ? useCaseMatch(agents.useCase, useCases) : undefined,
          ),
    );
  }

  /**
   * Agents visible to the principal (own tenant only, team and agent-scoped bindings applied),
   * newest first, keyset-paged. Every filter is ANDed with the visibility scope: a filter value
   * can only narrow the result, never reach an agent the principal cannot read.
   */
  async list(principal: Principal, query: AgentListQuery, subtree?: ResolvedScope) {
    const c = decodeTimeCursor(query.cursor);
    const visibility = this.visibility(principal, subtree);
    if (!visibility) return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select({ agent: agents })
      .from(agents)
      .leftJoin(
        agentVersions,
        and(eq(agentVersions.id, agents.latestVersionId), eq(agentVersions.agentId, agents.id)),
      )
      .where(
        and(
          visibility,
          query.q ? textFilter(query.q) : undefined,
          query.teamId ? eq(agents.teamId, query.teamId) : undefined,
          query.useCase ? useCaseFilter(query.useCase) : undefined,
          query.status ? statusFilter(query.status) : undefined,
          c
            ? or(lt(agents.createdAt, c.t), and(eq(agents.createdAt, c.t), lt(agents.id, c.id)))
            : undefined,
        ),
      )
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(query.limit + 1);
    return page(
      rows.map((r) => r.agent),
      query.limit,
      (r) => encodeTimeCursor(r.createdAt, r.id),
    );
  }

  async updateDraft(principal: Principal, id: string, source: string): Promise<AgentRow> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:write');
    this.assertLegacyWritable();
    const def = loadAgentDefinition(source);
    if (def.name !== agent.name)
      throw new HttpError(400, 'validation_failed', `name must stay "${agent.name}"`);
    this.assertLabelInScope(principal, 'agents:write', agent, useCaseOf(def));
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // Serialised with reviews, decisions and other saves of this agent (ADR 0017 section 4.3).
      const locked = await lockAgent(tx, id);
      const { revision, previous, created } = await appendRevision(
        tx,
        locked,
        source,
        authorOf(principal.userId),
        (r) => this.auditRevision(tx, locked, r, 'system').then(() => undefined),
      );
      // Identical content (same normalised digest) creates no revision and changes nothing: the
      // draft stays byte for byte the source of its newest revision.
      const [row] = created
        ? await tx
            .update(agents)
            .set({
              draftSource: source,
              draftUpdatedAt: this.ctx.now(),
              description: def.description ?? null,
              // The published version keeps defining the use case until a newer one is published.
              ...(agent.latestVersionId ? {} : { useCase: useCaseOf(def) }),
            })
            .where(eq(agents.id, id))
            .returning()
        : [{ ...locked, draftRevisionId: revision.id }];
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.draft.updated',
          target: id,
          payload: { version: def.version, digest: def.digest },
        },
        tx,
      );
      if (created) {
        await this.auditRevision(tx, locked, revision, principal.userId);
        await this.staleOpenReview(tx, locked, previous);
      }
      return row!;
    });
  }

  /**
   * A new revision makes every approval of an open review on the previous one stale (ADR 0017
   * section 3): they are listed, not counted. This only records it in the audit trail.
   */
  private async staleOpenReview(tx: Db, agent: AgentRow, previous: RevisionRow): Promise<void> {
    const [review] = await tx
      .select({ id: agentReviews.id })
      .from(agentReviews)
      .where(and(eq(agentReviews.agentId, agent.id), eq(agentReviews.status, 'open')));
    if (!review) return;
    const rows = await tx
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id));
    const facts: DecisionFact[] = rows.map((d) => ({
      id: d.id,
      reviewerId: d.reviewerId,
      decision: d.decision as DecisionFact['decision'],
      revisionId: d.revisionId,
      decidedAt: d.decidedAt,
      expiresAt: d.expiresAt,
    }));
    const stale = summariseDecisions(facts, previous.id, this.ctx.now());
    const approvals = stale.approvers.length;
    if (approvals + stale.changesRequested.length === 0) return;
    await this.audit.append(
      {
        actor: 'system',
        tenantId: agent.tenantId,
        action: 'agent.review.stale',
        target: agent.id,
        payload: {
          review: review.id,
          approvals,
          changesRequested: stale.changesRequested.length,
          reason: 'revision_changed',
        },
      },
      tx,
    );
  }

  /** Platform constraints on `runtime`: enabled runners and the toolbox allowlist. */
  checkRuntime(def: AgentDefinition): void {
    const issues: { path: string; message: string }[] = [];
    const { runners, toolboxes } = this.ctx.config;
    if (!runners.enabled.includes(def.runtime.runner)) {
      issues.push({
        path: 'runtime.runner',
        message: `runner "${def.runtime.runner}" is not enabled (OAX_RUNNERS_ENABLED=${runners.enabled.join(',')})`,
      });
    }
    // Per-step runners (ADR 0008): a step may run elsewhere than the pipeline, never on a runner
    // that is not enabled.
    def.agents.forEach((a, i) => {
      const r = a.runtime?.runner;
      if (r && !runners.enabled.includes(r))
        issues.push({
          path: `agents.${i}.runtime.runner`,
          message: `runner "${r}" is not enabled (OAX_RUNNERS_ENABLED=${runners.enabled.join(',')})`,
        });
    });
    // Harness steps (ADR 0009 section 10): only harnesses the operator enabled, on an isolating
    // runner that is enabled too (the definition check already rejects in-process and local).
    def.agents.forEach((a, i) => {
      const h = a.runtime?.harness;
      if (h && !this.ctx.config.harnesses.enabled.includes(h))
        issues.push({
          path: `agents.${i}.runtime.harness`,
          message: `harness "${h}" is not enabled (OAX_HARNESSES_ENABLED=${this.ctx.config.harnesses.enabled.join(',')})`,
        });
      if (!h) {
        // A normal step never runs on a harness image (it carries a proprietary binary and the
        // harness's settings): neither its toolbox nor the default image may be one.
        const cfg = runners.container.config;
        const isContainer = (a.runtime?.runner ?? def.runtime.runner) === 'container';
        if (cfg && isContainer) {
          const harnessImages = Object.values(cfg.harnessImages);
          const toolbox = a.toolbox ?? def.runtime.toolbox;
          const image = toolbox ? cfg.toolboxImages[toolbox] : cfg.image;
          if (image && harnessImages.includes(image))
            issues.push({
              path: `agents.${i}.${a.toolbox ? 'toolbox' : 'runtime.runner'}`,
              message: `step "${a.id}" has no harness but would run on a harness image; harness images are reserved for steps with runtime.harness`,
            });
        }
        return;
      }
      if (a.toolbox)
        issues.push({
          path: `agents.${i}.toolbox`,
          message: `harness step "${a.id}" must not set a toolbox: it runs on the image of its harness`,
        });
      // "Control node only": a harness step holds a model token and runs untrusted tool output, so it
      // publishes without egress hosts unless the operator opened that explicitly (DOG-1).
      const egress = a.runtime?.egress ?? def.runtime.egress;
      if (egress.length > 0 && !this.ctx.config.harnesses.egressAllowed)
        issues.push({
          path: `agents.${i}.runtime.egress`,
          message: `harness step "${a.id}" must not declare egress (runtime.egress: []); set OAX_HARNESS_EGRESS_ALLOWED=true to allow it`,
        });
      // The image of the harness must exist: otherwise the step would only fail when it starts.
      const container = runners.container.config;
      if (
        (a.runtime?.runner ?? def.runtime.runner) === 'container' &&
        container &&
        !container.harnessImages[h]
      )
        issues.push({
          path: `agents.${i}.runtime.harness`,
          message: `no run node image is configured for harness "${h}" (OAX_CONTAINER_HARNESS_IMAGES)`,
        });
    });
    // Step egress of container steps must lie inside the operator ceiling (never a union with it).
    const ceiling = (runners.container.config?.egressAllow ?? []).map(parseEgressEntry);
    def.agents.forEach((a, i) => {
      if ((a.runtime?.runner ?? def.runtime.runner) !== 'container') return;
      try {
        assertWithinCeiling(a.runtime?.egress ?? def.runtime.egress, ceiling);
      } catch (e) {
        issues.push({ path: `agents.${i}.runtime.egress`, message: (e as Error).message });
      }
    });
    if (toolboxes.allowlist.length > 0) {
      const used = [def.runtime.toolbox, ...def.agents.map((a) => a.toolbox)].filter(
        (t): t is string => !!t,
      );
      for (const t of new Set(used)) {
        if (!toolboxes.allowlist.includes(t))
          issues.push({
            path: 'runtime.toolbox',
            message: `toolbox "${t}" is not in OAX_TOOLBOX_ALLOWLIST`,
          });
      }
    }
    if (issues.length)
      throw new HttpError(
        400,
        'validation_failed',
        'agent runtime is not allowed on this platform',
        issues,
      );
  }

  /**
   * Switches an agent off (UX slice A7). Needs `agents:publish` on the agent, like publishing.
   * A disabled agent accepts no new runs (`409 agent_disabled`, see `RunsService.enqueue` and the
   * worker's claim query); runs that already started finish unless someone cancels them, and its
   * published versions stay immutable and readable. Idempotent: disabling a disabled agent changes
   * nothing (the first actor, time and reason stay) and writes no second audit entry.
   */
  async disable(
    principal: Principal,
    id: string,
    reason?: string | null,
  ): Promise<{ agent: AgentRow; changed: boolean }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    const text = cleanReason(reason);
    if (text && text.length > MAX_DISABLE_REASON_LENGTH)
      throw new HttpError(400, 'validation_failed', 'reason must not exceed 500 characters');
    return this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ disabledAt: this.ctx.now(), disabledBy: principal.userId, disabledReason: text })
        .where(
          and(
            eq(agents.id, id),
            eq(agents.tenantId, principal.tenantId),
            isNull(agents.disabledAt),
          ),
        )
        .returning();
      if (!row)
        return { agent: await this.reload(tx as unknown as Db, id, principal), changed: false };
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.disabled',
          target: id,
          payload: { reason: text },
        },
        tx as unknown as Db,
      );
      return { agent: row, changed: true };
    });
  }

  /** Switches a disabled agent back on; runs, triggers and the scheduler pick it up again. */
  async enable(
    principal: Principal,
    id: string,
    reason?: string | null,
  ): Promise<{ agent: AgentRow; changed: boolean }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    const text = cleanReason(reason);
    if (text && text.length > MAX_DISABLE_REASON_LENGTH)
      throw new HttpError(400, 'validation_failed', 'reason must not exceed 500 characters');
    return this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ disabledAt: null, disabledBy: null, disabledReason: null })
        .where(
          and(
            eq(agents.id, id),
            eq(agents.tenantId, principal.tenantId),
            isNotNull(agents.disabledAt),
          ),
        )
        .returning();
      if (!row)
        return { agent: await this.reload(tx as unknown as Db, id, principal), changed: false };
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.enabled',
          target: id,
          payload: {
            reason: text,
            wasDisabledAt: agent.disabledAt?.toISOString() ?? null,
          },
        },
        tx as unknown as Db,
      );
      return { agent: row, changed: true };
    });
  }

  private async reload(db: Db, id: string, principal: Principal): Promise<AgentRow> {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.tenantId, principal.tenantId)));
    if (!row) throw notFound('agent');
    return row;
  }

  /** Publishes the current draft as an immutable version (idempotent for identical content). */
  async publish(
    principal: Principal,
    id: string,
  ): Promise<{ version: VersionSummary; created: boolean; shadow?: ShadowReport }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    this.assertLegacyWritable();
    const def = loadAgentDefinition(agent.draftSource);
    this.assertLabelInScope(principal, 'agents:publish', agent, useCaseOf(def));
    this.checkRuntime(def);
    const published = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id));
    const outcome = checkPublish(published, def);
    // ADR 0017 S1, shadow mode: report what publish would be refused for once approvals are
    // enforced. It never refuses anything and must never break a publish.
    const shadow = await this.shadow(agent);
    if (outcome === 'unchanged') {
      return {
        version: summary(published.find((p) => p.version === def.version)!),
        created: false,
        ...(shadow ? { shadow } : {}),
      };
    }
    // Profile grants become concrete grants now and are stored with the version: a later change
    // of a profile never widens it. Read-only steps never receive a write tool.
    const { definition, errors } = expandProfiles(
      def,
      await this.catalog.accessCatalog({
        tenantId: principal.tenantId,
        teamId: agent.teamId,
        agentId: id,
      }),
    );
    if (errors.length > 0) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.publish.denied',
        target: id,
        payload: { version: def.version, digest: def.digest, errors },
      });
      // ADR 0016 S3: tool definitions that were never reviewed (or a tool the review does not list)
      // are a refusal of their own, so a client can send the user to the Tools tab.
      const pinCode = errors.find(
        (e) => e.code === 'mcp_tools_unreviewed' || e.code === 'mcp_tool_unknown',
      )?.code;
      throw new HttpError(
        400,
        pinCode ?? 'validation_failed',
        pinCode
          ? 'the tool definitions of an MCP connection are not approved for these grants'
          : 'tool grants are not allowed on this platform',
        errors,
      );
    }
    // ADR 0016 S0: a tenant-defined stdio server never starts in the worker process.
    const stdio = await this.catalog.stdioIsolationIssues(def, {
      tenantId: principal.tenantId,
      teamId: agent.teamId,
      agentId: id,
    });
    if (stdio.length > 0) {
      const errors = stdio.map(({ path, message }) => ({ path, message }));
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.publish.denied',
        target: id,
        payload: {
          version: def.version,
          digest: def.digest,
          code: 'mcp_stdio_requires_isolation',
          errors,
        },
      });
      throw new HttpError(
        400,
        'mcp_stdio_requires_isolation',
        'tenant stdio connections run only in run nodes',
        errors,
      );
    }
    const row = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // The draft is read again under the agent lock: a save that slipped in since the checks above
      // would otherwise publish content that was never validated (ADR 0017 section 4.3).
      const locked = await lockAgent(tx, id);
      if (locked.draftSource !== agent.draftSource)
        throw new HttpError(409, 'draft_changed', 'the draft changed while publishing; try again');
      const head = await ensureHead(tx, locked, (r) =>
        this.auditRevision(tx, locked, r, 'system').then(() => undefined),
      );
      const [v] = await tx
        .insert(agentVersions)
        .values({
          id: randomUUID(),
          agentId: id,
          version: def.version,
          digest: def.digest,
          source: agent.draftSource,
          definition: definition as unknown as object,
          publishedBy: principal.userId,
          revisionId: head.id,
        })
        .returning();
      await tx
        .update(agents)
        .set({ latestVersionId: v!.id, latestVersion: v!.version, useCase: useCaseOf(def) })
        .where(eq(agents.id, id));
      // AWP-3b: the effective AWP manifest is stored next to the version (never in it). A refusal is
      // stored as `legacy-unconvertible`. The row is written in a savepoint: a database error there
      // is logged and does not fail the publish; the version then has no row and the one-time
      // conversion (or the read path) converts it later.
      try {
        const conversion = await convertDefinition(
          locked,
          v!.definition as PublishedDefinition,
          teamLookup(tx, locked.tenantId),
        );
        await tx.transaction((sp) => storeConversion(sp as unknown as Db, v!, conversion));
      } catch (e) {
        this.ctx.logger.warn(
          { err: e, agent: id, version: v!.version },
          'AWP conversion not stored',
        );
      }
      return v!;
    });
    await this.ctx.cache.del(`agent-latest:${id}`);
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'agent.published',
      target: id,
      payload: {
        version: row.version,
        digest: row.digest,
        revision: row.revisionId,
        ...(shadow ? { shadow } : {}),
      },
    });
    if (definition.expansion?.length) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.profiles.expanded',
        target: id,
        payload: {
          version: row.version,
          expansionDigest: definition.expansionDigest,
          expansion: definition.expansion,
        },
      });
    }
    return { version: summary(row), created: true, ...(shadow ? { shadow } : {}) };
  }

  /** The shadow report of a publish, or `undefined` when it cannot be computed (never an error). */
  private async shadow(agent: AgentRow): Promise<ShadowReport | undefined> {
    if (!this.shadowPublish) return undefined;
    try {
      return await this.shadowPublish(agent, agent.draftSource);
    } catch (e) {
      this.ctx.logger.warn({ err: e, agent: agent.id }, 'publish shadow check failed');
      return undefined;
    }
  }

  /** The stored AWP conversion of a version, if the one-time conversion or its publish made one. */
  awpOf(versionId: string): Promise<StoredAwpRow | undefined> {
    return awpRowOf(this.ctx.db, versionId);
  }

  /**
   * `oax awp legacy-report` for stored versions: how many versions of the visible agents are
   * converted, unconvertible or not yet converted, and the unconvertible ones with the field-level
   * reasons of the refusal. Newest first, keyset-paged.
   */
  async legacyReport(principal: Principal, query: { limit: number; cursor?: string | undefined }) {
    const visibility = this.visibility(principal, undefined);
    const empty = {
      counts: { converted: 0, unconvertible: 0, pending: 0 },
      items: [],
      nextCursor: null,
    };
    if (!visibility) return empty;
    const c = decodeTimeCursor(query.cursor);
    const counts = await this.ctx.db
      .select({ status: agentVersionAwp.status, n: sql<number>`count(*)::int` })
      .from(agentVersionAwp)
      .innerJoin(agents, eq(agents.id, agentVersionAwp.agentId))
      .where(visibility)
      .groupBy(agentVersionAwp.status);
    const [pending] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .leftJoin(agentVersionAwp, eq(agentVersionAwp.versionId, agentVersions.id))
      .where(and(visibility, isNull(agentVersionAwp.versionId)));
    const rows = await this.ctx.db
      .select({
        row: agentVersionAwp,
        agentName: agents.name,
        version: agentVersions.version,
      })
      .from(agentVersionAwp)
      .innerJoin(agents, eq(agents.id, agentVersionAwp.agentId))
      .innerJoin(agentVersions, eq(agentVersions.id, agentVersionAwp.versionId))
      .where(
        and(
          visibility,
          eq(agentVersionAwp.status, 'legacy-unconvertible'),
          c
            ? or(
                lt(agentVersionAwp.convertedAt, c.t),
                and(eq(agentVersionAwp.convertedAt, c.t), lt(agentVersionAwp.versionId, c.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(agentVersionAwp.convertedAt), desc(agentVersionAwp.versionId))
      .limit(query.limit + 1);
    const out = page(rows, query.limit, (r) =>
      encodeTimeCursor(r.row.convertedAt, r.row.versionId),
    );
    return {
      counts: {
        converted: counts.find((r) => r.status === 'converted')?.n ?? 0,
        unconvertible: counts.find((r) => r.status === 'legacy-unconvertible')?.n ?? 0,
        pending: pending?.n ?? 0,
      },
      items: out.items.map((r) => ({
        agentId: r.row.agentId,
        agentName: r.agentName,
        versionId: r.row.versionId,
        version: r.version,
        findings: r.row.findings as { code: string; path: string; message: string }[],
      })),
      nextCursor: out.nextCursor,
    };
  }

  async versions(id: string): Promise<VersionSummary[]> {
    const rows = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id))
      .orderBy(desc(agentVersions.publishedAt));
    return rows.map(summary);
  }

  async getVersion(agentId: string, version: string): Promise<AgentVersionRow> {
    const [row] = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
    if (!row) throw notFound('agent version');
    return row;
  }

  /** Published versions are immutable, so the parsed definition can be cached for a long time. */
  async definitionOf(
    versionId: string,
  ): Promise<{ id: string; agentId: string; version: string; definition: AgentDefinition }> {
    const v = await cached(
      this.ctx.cache,
      `agent-version:${versionId}`,
      IMMUTABLE_TTL,
      async () => {
        const [row] = await this.ctx.db
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.id, versionId));
        return row
          ? {
              id: row.id,
              agentId: row.agentId,
              version: row.version,
              definition: row.definition as AgentDefinition,
            }
          : null;
      },
    );
    if (!v) throw notFound('agent version');
    return v;
  }

  async latestVersionId(
    agentId: string,
  ): Promise<{ versionId: string | null; teamId: string | null; tenantId: string }> {
    return cached(this.ctx.cache, `agent-latest:${agentId}`, 60_000, async () => {
      const [a] = await this.ctx.db
        .select({ v: agents.latestVersionId, t: agents.teamId, tenantId: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!a) throw notFound('agent');
      return { versionId: a.v, teamId: a.t, tenantId: a.tenantId };
    });
  }

  /** The ids among `ids` whose agent is disabled (used by the scheduler for cron event sources). */
  async disabledAgentIds(ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const rows = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, unique), isNotNull(agents.disabledAt)));
    return new Set(rows.map((r) => r.id));
  }

  /** Enabled, published agents with cron triggers (used by the scheduler; disabled agents have none). */
  async cronAgents(): Promise<
    { agentId: string; versionId: string; schedule: string; timezone?: string }[]
  > {
    const rows = await this.ctx.db
      .select({ agentId: agents.id, versionId: agents.latestVersionId })
      .from(agents)
      .where(and(isNotNull(agents.latestVersionId), isNull(agents.disabledAt)));
    const out: { agentId: string; versionId: string; schedule: string; timezone?: string }[] = [];
    for (const r of rows) {
      const { definition } = await this.definitionOf(r.versionId!);
      for (const t of definition.triggers) {
        if (t.type === 'cron')
          out.push({
            agentId: r.agentId,
            versionId: r.versionId!,
            schedule: t.schedule,
            ...(t.timezone ? { timezone: t.timezone } : {}),
          });
      }
    }
    return out;
  }
}
