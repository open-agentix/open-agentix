import { randomUUID } from 'node:crypto';
import {
  McpPinError,
  SECRET_PATTERNS,
  changedToolNames,
  classifyTool,
  digestMatchesAny,
  grantedTools,
  pinnedToolsOf,
  toolsDigest,
  type AgentDefinition,
  type PinnedTool,
  type Principal,
  type PublishedDefinition,
  type ToolAccess,
  type ToolPinRecord,
  type RunTokenClaims,
} from '@openagentix/core';
import {
  McpServerConfigSchema,
  type McpTestCategory,
  type McpTool,
  type ToolPinCheck,
} from '@openagentix/mcp';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  agentVersions,
  agents,
  mcpToolSnapshotAcceptances,
  mcpToolSnapshots,
} from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { CatalogService, ConnectionRow, RunScope } from './catalog.js';
import type { McpTestService } from './mcp-test.js';
import type { RunNodesService } from './run-nodes.js';

/** Pending snapshots kept per connection (oldest run-detected ones are dropped beyond this). */
const MAX_PENDING = 20;
/** Changes recorded per run and replica (a run has a handful of servers; the rest is noise). */
const MAX_REPORTS_PER_RUN = 10;
/** Names listed in one audit entry (names only, never descriptions). */
const MAX_AUDIT_NAMES = 50;

export type ApprovalScope = 'new-versions' | 'existing-versions';
type SnapshotRow = typeof mcpToolSnapshots.$inferSelect;

export interface SnapshotSummary {
  digest: string;
  status: 'pending' | 'approved' | 'rejected';
  source: 'refresh' | 'run';
  toolCount: number;
  fetchedAt: string;
  approvedAt: string | null;
  approvalScope: ApprovalScope | null;
  rejectedAt: string | null;
  /** The snapshot a version published now would pin (latest approved). */
  current: boolean;
  /** Published versions of the caller's tenant that pinned this snapshot. */
  pinnedVersions: number;
}

export interface SnapshotDetail extends SnapshotSummary {
  tools: PinnedTool[];
  /** The current approved snapshot to diff against (null when this is it or none exists). */
  base: { digest: string; tools: PinnedTool[] } | null;
  /** Names added, removed or changed relative to `base`. */
  changed: string[];
  pinnedBy: { agentId: string; agent: string; version: string }[];
}

const summary = (r: SnapshotRow, current: string | null, pinned: number): SnapshotSummary => ({
  digest: r.digest,
  status: r.status as SnapshotSummary['status'],
  source: r.source as SnapshotSummary['source'],
  toolCount: r.toolCount,
  fetchedAt: r.fetchedAt.toISOString(),
  approvedAt: r.approvedAt?.toISOString() ?? null,
  approvalScope: r.approvalScope as ApprovalScope | null,
  rejectedAt: r.rejectedAt?.toISOString() ?? null,
  current: r.digest === current,
  pinnedVersions: pinned,
});

/** Credential-shaped strings and known secret values: a snapshot must hold none (fail closed). */
function secretKinds(tools: unknown, known: readonly string[]): string[] {
  const text = JSON.stringify(tools);
  const kinds = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (known.some((v) => v.length >= 8 && text.includes(v))) kinds.push('known-secret');
  return kinds;
}

const classOf = (declared: Record<string, { access: ToolAccess }>, t: PinnedTool): ToolAccess =>
  classifyTool(
    Object.hasOwn(declared, t.name) ? declared[t.name]!.access : undefined,
    t.annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | null | undefined,
  );

/**
 * Tool snapshots, their review and their use at publish and run time (ADR 0016 section 5).
 *
 * Tool definitions come from servers the platform does not control: they are bounded, reduced to
 * the model-visible fields, scanned for credentials and stored per connection under the tenant that
 * owns it. Every query names that tenant; a connection the caller cannot see is `404`, exactly
 * like a connection that does not exist.
 */
export class McpToolsService {
  /** (run, server, digest) already reported by a node: a node repeating itself costs nothing. */
  private readonly reported = new Set<string>();
  private readonly reportsPerRun = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly mcpTest: McpTestService,
    private readonly runNodes: RunNodesService,
  ) {}

  // ---------- reading ----------

  private async mcpConnection(actor: Principal, id: string): Promise<ConnectionRow> {
    const row = await this.catalog.getConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    return row;
  }

  private async currentDigest(row: ConnectionRow, db: Db = this.ctx.db): Promise<string | null> {
    const [r] = await db
      .select({ digest: mcpToolSnapshots.digest })
      .from(mcpToolSnapshots)
      .where(
        and(
          eq(mcpToolSnapshots.connectionId, row.id),
          eq(mcpToolSnapshots.tenantId, row.tenantId),
          eq(mcpToolSnapshots.status, 'approved'),
        ),
      )
      .orderBy(desc(mcpToolSnapshots.approvedAt), desc(mcpToolSnapshots.id))
      .limit(1);
    return r?.digest ?? null;
  }

  /** Published versions of the caller's tenant per pinned snapshot digest of this connection. */
  private async pinnedVersions(
    actor: Principal,
    row: ConnectionRow,
  ): Promise<{ digest: string; agentId: string; agent: string; version: string }[]> {
    const rows = await this.ctx.db
      .select({
        digest: sql<string>`${agentVersions.definition} #>> array['toolPins', ${row.name}, 'snapshotDigest']`,
        agentId: agents.id,
        agent: agents.name,
        version: agentVersions.version,
      })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .where(
        and(
          eq(agents.tenantId, actor.tenantId),
          sql`${agentVersions.definition} #> array['toolPins', ${row.name}] is not null`,
        ),
      )
      .limit(5000);
    return rows.filter((r) => typeof r.digest === 'string');
  }

  async list(actor: Principal, id: string): Promise<{ items: SnapshotSummary[] }> {
    const row = await this.mcpConnection(actor, id);
    const [snaps, current, pinned] = await Promise.all([
      this.ctx.db
        .select()
        .from(mcpToolSnapshots)
        .where(
          and(
            eq(mcpToolSnapshots.connectionId, row.id),
            eq(mcpToolSnapshots.tenantId, row.tenantId),
          ),
        )
        .orderBy(desc(mcpToolSnapshots.fetchedAt), desc(mcpToolSnapshots.id))
        .limit(200),
      this.currentDigest(row),
      this.pinnedVersions(actor, row),
    ]);
    const count = new Map<string, number>();
    for (const p of pinned) count.set(p.digest, (count.get(p.digest) ?? 0) + 1);
    return { items: snaps.map((s) => summary(s, current, count.get(s.digest) ?? 0)) };
  }

  private async snapshot(row: ConnectionRow, digest: string): Promise<SnapshotRow> {
    const [snap] = await this.ctx.db
      .select()
      .from(mcpToolSnapshots)
      .where(
        and(
          eq(mcpToolSnapshots.connectionId, row.id),
          eq(mcpToolSnapshots.tenantId, row.tenantId),
          eq(mcpToolSnapshots.digest, digest),
        ),
      );
    if (!snap) throw notFound('tool snapshot');
    return snap;
  }

  async get(actor: Principal, id: string, digest: string): Promise<SnapshotDetail> {
    const row = await this.mcpConnection(actor, id);
    const snap = await this.snapshot(row, digest);
    const current = await this.currentDigest(row);
    const pinned = (await this.pinnedVersions(actor, row)).filter((p) => p.digest === digest);
    let base: SnapshotDetail['base'] = null;
    if (current && current !== digest) {
      const b = await this.snapshot(row, current);
      base = { digest: b.digest, tools: b.tools as PinnedTool[] };
    }
    const tools = snap.tools as PinnedTool[];
    return {
      ...summary(snap, current, pinned.length),
      tools,
      base,
      changed: base ? changedToolNames(base.tools, tools).slice(0, 500) : [],
      pinnedBy: pinned.slice(0, 100).map((p) => ({
        agentId: p.agentId,
        agent: p.agent,
        version: p.version,
      })),
    };
  }

  // ---------- refresh ----------

  /**
   * Fetches the tool list of an HTTP MCP connection through the same transport as a run and stores
   * it as a pending snapshot (or finds the one with the same digest). The answer carries the
   * category of the connection test and the snapshot summary, never a tool text.
   */
  async refresh(
    actor: Principal,
    id: string,
  ): Promise<{
    ok: boolean;
    category: McpTestCategory;
    snapshot?: SnapshotSummary;
    created?: boolean;
    matchesCurrent?: boolean;
  }> {
    const own = await this.catalog.getOwnConnection(actor, id);
    if (own.kind !== 'mcp') throw notFound('MCP connection');
    const { row, result, tools, secrets } = await this.mcpTest.probe(actor, id, 'refresh');
    const audit = (payload: Record<string, unknown>) =>
      this.audit.append({
        actor: actor.userId,
        tenantId: row.tenantId,
        action: 'mcp.tools.refreshed',
        target: id,
        payload: { connection: row.name, ...payload },
      });
    if (!result.ok || !tools) {
      await audit({ outcome: 'failed', category: result.category });
      return { ok: false, category: result.category };
    }
    let reduced: PinnedTool[];
    try {
      reduced = pinnedToolsOf(tools as McpTool[]);
    } catch (e) {
      const code = e instanceof McpPinError ? e.code : 'mcp_tool_invalid';
      await audit({ outcome: 'refused', code });
      throw new HttpError(422, code, 'the server returned tool definitions that cannot be pinned');
    }
    const kinds = secretKinds(reduced, secrets);
    if (kinds.length > 0) {
      await audit({ outcome: 'refused', code: 'mcp_tools_contain_secret', kinds });
      throw new HttpError(
        422,
        'mcp_tools_contain_secret',
        'the tool definitions contain what looks like a credential and are not stored',
      );
    }
    const digest = toolsDigest(reduced);
    const [inserted] = await this.ctx.db
      .insert(mcpToolSnapshots)
      .values({
        id: randomUUID(),
        tenantId: row.tenantId,
        connectionId: row.id,
        digest,
        tools: reduced,
        toolCount: reduced.length,
        status: 'pending',
        source: 'refresh',
        fetchedAt: this.ctx.now(),
        fetchedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    let snap = inserted;
    if (!snap) {
      snap = await this.snapshot(row, digest);
      // An explicit refresh that sees a rejected list again reopens it for review.
      if (snap.status === 'rejected') {
        const [reopened] = await this.ctx.db
          .update(mcpToolSnapshots)
          .set({ status: 'pending', rejectedBy: null, rejectedAt: null, fetchedAt: this.ctx.now() })
          .where(and(eq(mcpToolSnapshots.id, snap.id), eq(mcpToolSnapshots.status, 'rejected')))
          .returning();
        snap = reopened ?? snap;
      }
    }
    const current = await this.currentDigest(row);
    await audit({
      outcome: 'ok',
      digest,
      toolCount: reduced.length,
      status: snap.status,
      created: Boolean(inserted),
      matchesCurrent: current === digest,
    });
    return {
      ok: true,
      category: 'ok',
      snapshot: summary(snap, current, 0),
      created: Boolean(inserted),
      matchesCurrent: current === digest,
    };
  }

  // ---------- review ----------

  /** Whether every version that may still use `fromSet` keeps its granted names and classes. */
  private async approvalConflicts(
    db: Db,
    row: ConnectionRow,
    target: SnapshotRow,
    fromSet: readonly string[],
  ): Promise<{ versions: number; tools: string[] }> {
    const declared = (() => {
      const parsed = McpServerConfigSchema.safeParse(row.config);
      return parsed.success ? parsed.data.tools : {};
    })();
    const pinned = await db
      .select({
        pin: sql<ToolPinRecord>`${agentVersions.definition} #> array['toolPins', ${row.name}]`,
      })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .where(
        and(
          // A platform connection is pinned by versions of any tenant; others only by their own.
          row.scope === 'platform' ? undefined : eq(agents.tenantId, row.tenantId),
          inArray(
            sql`${agentVersions.definition} #>> array['toolPins', ${row.name}, 'snapshotDigest']`,
            [...fromSet],
          ),
        ),
      )
      .limit(5000);
    const older = await db
      .select()
      .from(mcpToolSnapshots)
      .where(
        and(
          eq(mcpToolSnapshots.connectionId, row.id),
          eq(mcpToolSnapshots.tenantId, row.tenantId),
          inArray(mcpToolSnapshots.digest, [...fromSet]),
        ),
      );
    const byDigest = new Map(older.map((s) => [s.digest, s.tools as PinnedTool[]]));
    const newTools = target.tools as PinnedTool[];
    const bad = new Set<string>();
    let versions = 0;
    for (const { pin } of pinned) {
      if (!pin || !Array.isArray(pin.granted)) continue;
      const oldTools = byDigest.get(pin.snapshotDigest);
      if (!oldTools) {
        versions++;
        continue;
      }
      const before = new Map(
        grantedTools(oldTools, pin.granted).map((t) => [t.name, classOf(declared, t)]),
      );
      const after = new Map(
        grantedTools(newTools, pin.granted).map((t) => [t.name, classOf(declared, t)]),
      );
      let violated = false;
      for (const [name, cls] of before) {
        if (after.get(name) !== cls) {
          bad.add(name);
          violated = true;
        }
      }
      for (const name of after.keys())
        if (!before.has(name)) {
          bad.add(name);
          violated = true;
        }
      if (violated) versions++;
    }
    return { versions, tools: [...bad].sort().slice(0, MAX_AUDIT_NAMES) };
  }

  async approve(
    actor: Principal,
    id: string,
    digest: string,
    scope: ApprovalScope,
  ): Promise<SnapshotSummary> {
    const row = await this.catalog.getOwnConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    const outcome = await this.ctx.db.transaction(async (tx) => {
      // One review decision at a time per connection (the "latest approved" must not race).
      await tx.execute(sql`select 1 from connections where id = ${row.id} for update`);
      const [snap] = await tx
        .select()
        .from(mcpToolSnapshots)
        .where(
          and(
            eq(mcpToolSnapshots.connectionId, row.id),
            eq(mcpToolSnapshots.tenantId, row.tenantId),
            eq(mcpToolSnapshots.digest, digest),
          ),
        );
      if (!snap) throw notFound('tool snapshot');
      if (snap.status === 'approved' && snap.approvalScope === scope)
        return {
          kind: 'done' as const,
          summary: summary(snap, await this.currentDigest(row, tx), 0),
        };
      if (snap.status !== 'pending')
        throw new HttpError(
          409,
          'invalid_state',
          `a ${snap.status} tool snapshot cannot be approved (refresh the connection to review it again)`,
        );
      const [previous] = await tx
        .select()
        .from(mcpToolSnapshots)
        .where(
          and(
            eq(mcpToolSnapshots.connectionId, row.id),
            eq(mcpToolSnapshots.tenantId, row.tenantId),
            eq(mcpToolSnapshots.status, 'approved'),
          ),
        )
        .orderBy(desc(mcpToolSnapshots.approvedAt), desc(mcpToolSnapshots.id))
        .limit(1);
      let accepted = false;
      if (scope === 'existing-versions') {
        if (!previous)
          throw new HttpError(
            409,
            'mcp_no_previous_snapshot',
            'there is no approved snapshot that existing versions could have pinned',
          );
        // Every digest from which the previous one is reachable through earlier acceptances: a
        // version that pinned any of them runs against the previous snapshot today.
        const edges = await tx
          .select()
          .from(mcpToolSnapshotAcceptances)
          .where(
            and(
              eq(mcpToolSnapshotAcceptances.connectionId, row.id),
              eq(mcpToolSnapshotAcceptances.tenantId, row.tenantId),
            ),
          );
        const set = new Set([previous.digest]);
        for (let grew = true; grew;) {
          grew = false;
          for (const e of edges)
            if (set.has(e.toDigest) && !set.has(e.fromDigest)) {
              set.add(e.fromDigest);
              grew = true;
            }
        }
        const conflicts = await this.approvalConflicts(tx, row, snap, [...set]);
        if (conflicts.versions > 0) return { kind: 'conflict' as const, conflicts };
        accepted = true;
        await tx
          .insert(mcpToolSnapshotAcceptances)
          .values({
            id: randomUUID(),
            tenantId: row.tenantId,
            connectionId: row.id,
            fromDigest: previous.digest,
            toDigest: snap.digest,
            acceptedBy: actor.userId,
            acceptedAt: this.ctx.now(),
          })
          .onConflictDoNothing();
      }
      const [done] = await tx
        .update(mcpToolSnapshots)
        .set({
          status: 'approved',
          approvedBy: actor.userId,
          approvedAt: this.ctx.now(),
          approvalScope: scope,
          rejectedBy: null,
          rejectedAt: null,
        })
        .where(and(eq(mcpToolSnapshots.id, snap.id), eq(mcpToolSnapshots.status, 'pending')))
        .returning();
      if (!done) throw new HttpError(409, 'invalid_state', 'the tool snapshot changed meanwhile');
      // In the same transaction: an approval without its audit entry (or the reverse) cannot exist.
      await this.audit.append(
        {
          actor: actor.userId,
          tenantId: row.tenantId,
          action: 'mcp.tools.approved',
          target: id,
          payload: {
            connection: row.name,
            digest,
            scope,
            previousDigest: previous?.digest ?? null,
            toolCount: done.toolCount,
            acceptance: accepted,
            changed: previous
              ? changedToolNames(previous.tools as PinnedTool[], done.tools as PinnedTool[]).slice(
                  0,
                  MAX_AUDIT_NAMES,
                )
              : [],
          },
        },
        tx,
      );
      return { kind: 'done' as const, summary: summary(done, digest, 0) };
    });
    if (outcome.kind === 'conflict') {
      // Outside the transaction, which was rolled back by nothing: the refusal is evidence.
      await this.audit.append({
        actor: actor.userId,
        tenantId: row.tenantId,
        action: 'mcp.tools.approval_denied',
        target: id,
        payload: {
          connection: row.name,
          digest,
          scope,
          code: 'mcp_tools_access_changed',
          versions: outcome.conflicts.versions,
          tools: outcome.conflicts.tools,
        },
      });
      throw new HttpError(
        409,
        'mcp_tools_access_changed',
        'the granted tools or their access classes changed, so published versions cannot accept this snapshot; approve it for new versions and publish again',
        { versions: outcome.conflicts.versions, tools: outcome.conflicts.tools },
      );
    }
    return outcome.summary;
  }

  async reject(actor: Principal, id: string, digest: string): Promise<SnapshotSummary> {
    const row = await this.catalog.getOwnConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    const snap = await this.snapshot(row, digest);
    if (snap.status === 'rejected') return summary(snap, await this.currentDigest(row), 0);
    if (snap.status !== 'pending')
      throw new HttpError(409, 'invalid_state', 'only a pending tool snapshot can be rejected');
    const [done] = await this.ctx.db
      .update(mcpToolSnapshots)
      .set({ status: 'rejected', rejectedBy: actor.userId, rejectedAt: this.ctx.now() })
      .where(and(eq(mcpToolSnapshots.id, snap.id), eq(mcpToolSnapshots.status, 'pending')))
      .returning();
    if (!done) throw new HttpError(409, 'invalid_state', 'the tool snapshot changed meanwhile');
    await this.audit.append({
      actor: actor.userId,
      tenantId: row.tenantId,
      action: 'mcp.tools.rejected',
      target: id,
      payload: { connection: row.name, digest, toolCount: done.toolCount },
    });
    return summary(done, await this.currentDigest(row), 0);
  }

  // ---------- use at run time ----------

  /**
   * The pins of a run for the gateway: per pinned server, the grants of the version and every
   * digest of the granted tools the run may accept, which are the pinned one and the ones of
   * snapshots reachable from the pinned snapshot through `existing-versions` acceptances of the
   * resolved connection. A server whose connection cannot be resolved accepts the pinned digest
   * only (fail closed).
   */
  async pinsFor(
    definition: AgentDefinition,
    scope: RunScope,
    servers?: ReadonlySet<string>,
  ): Promise<Record<string, ToolPinCheck>> {
    const pins = (definition as PublishedDefinition).toolPins ?? {};
    const out: Record<string, ToolPinCheck> = {};
    const names = Object.keys(pins).filter((n) => !servers || servers.has(n));
    if (names.length === 0) return out;
    const conns = await this.catalog.connectionsForRun('mcp', scope);
    for (const server of names) {
      const pin = pins[server]!;
      const accepted = [pin.toolsDigest];
      const conn = conns.find((c) => c.name === server);
      if (conn) {
        const edges = await this.ctx.db
          .select()
          .from(mcpToolSnapshotAcceptances)
          .where(
            and(
              eq(mcpToolSnapshotAcceptances.connectionId, conn.id),
              eq(mcpToolSnapshotAcceptances.tenantId, conn.tenantId),
            ),
          );
        const reach = new Set([pin.snapshotDigest]);
        for (let grew = true; grew;) {
          grew = false;
          for (const e of edges)
            if (reach.has(e.fromDigest) && !reach.has(e.toDigest)) {
              reach.add(e.toDigest);
              grew = true;
            }
        }
        reach.delete(pin.snapshotDigest);
        if (reach.size > 0) {
          const snaps = await this.ctx.db
            .select()
            .from(mcpToolSnapshots)
            .where(
              and(
                eq(mcpToolSnapshots.connectionId, conn.id),
                eq(mcpToolSnapshots.tenantId, conn.tenantId),
                eq(mcpToolSnapshots.status, 'approved'),
                inArray(mcpToolSnapshots.digest, [...reach]),
              ),
            );
          for (const s of snaps) {
            try {
              const tools = pinnedToolsOf(s.tools as unknown[]);
              if (toolsDigest(tools) !== s.digest) continue;
              accepted.push(toolsDigest(grantedTools(tools, pin.granted)));
            } catch {
              /* unusable snapshot: not accepted */
            }
          }
        }
      }
      out[server] = { granted: pin.granted, accepted: [...new Set(accepted)] };
    }
    return out;
  }

  /**
   * HTTP MCP servers a version holds grants on without a pinned definition: versions published
   * before ADR 0016 S3 (or against a server that was not pinnable). They run with a warning unless
   * `OAX_MCP_REQUIRE_TOOL_PIN` is set.
   */
  async unpinnedServers(definition: AgentDefinition, scope: RunScope): Promise<string[]> {
    const pins = (definition as PublishedDefinition).toolPins ?? {};
    const used = new Set(definition.agents.flatMap((a) => a.tools.map((t) => t.server)));
    if (used.size === 0) return [];
    const out: string[] = [];
    for (const c of await this.catalog.connectionsForRun('mcp', scope)) {
      if (!used.has(c.name) || pins[c.name]) continue;
      const parsed = McpServerConfigSchema.safeParse(c.config);
      if (parsed.success && parsed.data.transport === 'streamable-http') out.push(c.name);
    }
    return out.sort();
  }

  /**
   * A run (in-process or a node) read granted tools of a pinned server that differ from the pin.
   * Writes the audit entry (names and digests only), keeps the live list as a pending snapshot for
   * review and counts the event. Never throws: reporting must not decide the outcome of the step.
   */
  async reportChange(args: {
    runId: string;
    actor: string;
    definition: AgentDefinition;
    scope: RunScope;
    server: string;
    liveDigest: string;
    tools: unknown[] | null;
  }): Promise<void> {
    try {
      const pin = (args.definition as PublishedDefinition).toolPins?.[args.server];
      if (!pin) return;
      // Not a change at all (a node reporting an accepted digest): nothing to record.
      const accepted = (await this.pinsFor(args.definition, args.scope, new Set([args.server])))[
        args.server
      ]?.accepted ?? [pin.toolsDigest];
      if (digestMatchesAny(args.liveDigest, accepted)) return;
      const key = `${args.runId}|${args.server}|${args.liveDigest}`;
      if (this.reported.has(key)) return;
      // A node is untrusted: it may not turn one run into an unbounded stream of audit entries.
      const perRun = this.reportsPerRun.get(args.runId) ?? 0;
      if (perRun >= MAX_REPORTS_PER_RUN) return;
      if (this.reported.size > 10_000) {
        this.reported.clear();
        this.reportsPerRun.clear();
      }
      this.reported.add(key);
      this.reportsPerRun.set(args.runId, perRun + 1);
      this.ctx.metrics.mcpToolsChanged.inc();
      const conn = (await this.catalog.connectionsForRun('mcp', args.scope)).find(
        (c) => c.name === args.server,
      );
      let live: PinnedTool[] | null = null;
      try {
        live = args.tools ? pinnedToolsOf(args.tools) : null;
      } catch {
        live = null;
      }
      let changed: string[] = [];
      let liveSnapshot: string | null = null;
      let stored = false;
      if (live && conn) {
        const kinds = secretKinds(live, []);
        const pinnedSnap = await this.ctx.db
          .select()
          .from(mcpToolSnapshots)
          .where(
            and(
              eq(mcpToolSnapshots.connectionId, conn.id),
              eq(mcpToolSnapshots.tenantId, conn.tenantId),
              eq(mcpToolSnapshots.digest, pin.snapshotDigest),
            ),
          );
        const old = (pinnedSnap[0]?.tools ?? []) as PinnedTool[];
        changed = changedToolNames(
          grantedTools(old, pin.granted),
          grantedTools(live, pin.granted),
        ).slice(0, MAX_AUDIT_NAMES);
        liveSnapshot = toolsDigest(live);
        if (kinds.length === 0) {
          const [row] = await this.ctx.db
            .insert(mcpToolSnapshots)
            .values({
              id: randomUUID(),
              tenantId: conn.tenantId,
              connectionId: conn.id,
              digest: liveSnapshot,
              tools: live,
              toolCount: live.length,
              status: 'pending',
              source: 'run',
              fetchedAt: this.ctx.now(),
              runId: args.runId,
            })
            .onConflictDoNothing()
            .returning({ id: mcpToolSnapshots.id });
          stored = Boolean(row);
          if (stored) await this.prunePending(conn);
        }
      }
      await this.audit.append({
        actor: args.actor,
        tenantId: conn?.tenantId ?? args.scope.tenantId,
        action: 'mcp.tools.changed',
        target: conn?.id ?? args.server,
        runId: args.runId,
        payload: {
          connection: args.server,
          oldDigest: pin.toolsDigest,
          newDigest: args.liveDigest,
          snapshotDigest: liveSnapshot,
          tools: changed,
          pendingSnapshot: stored,
        },
      });
    } catch (err) {
      this.ctx.logger.warn({ err }, 'could not record a tool definition change');
    }
  }

  /** Keeps at most MAX_PENDING pending snapshots that runs detected; the oldest are deleted. */
  private async prunePending(conn: ConnectionRow): Promise<void> {
    const rows = await this.ctx.db
      .select({ id: mcpToolSnapshots.id })
      .from(mcpToolSnapshots)
      .where(
        and(
          eq(mcpToolSnapshots.connectionId, conn.id),
          eq(mcpToolSnapshots.tenantId, conn.tenantId),
          eq(mcpToolSnapshots.status, 'pending'),
          eq(mcpToolSnapshots.source, 'run'),
        ),
      )
      .orderBy(desc(mcpToolSnapshots.fetchedAt), desc(mcpToolSnapshots.id));
    const drop = rows.slice(MAX_PENDING).map((r) => r.id);
    if (drop.length > 0)
      await this.ctx.db.delete(mcpToolSnapshots).where(inArray(mcpToolSnapshots.id, drop));
  }

  /** A run node reports the tools it read (the node is untrusted: the digest is recomputed here). */
  async reportFromNode(
    claims: RunTokenClaims,
    runId: string,
    body: { agentId: string; server: string; liveDigest: string; tools?: unknown[] | undefined },
  ): Promise<void> {
    const s = await this.runNodes.checkSession(claims, runId);
    this.runNodes.assertStep(claims, body.agentId);
    const { run, definition } = await this.runNodes.runContext(runId);
    if (run.tenantId !== s.tenantId) throw notFound('run');
    const pin = (definition as PublishedDefinition).toolPins?.[body.server];
    // A node can only report a server its own step holds a pin and a grant for.
    const agent = definition.agents.find((a) => a.id === body.agentId);
    if (!pin || !agent || !agent.tools.some((t) => t.server === body.server))
      throw new HttpError(403, 'credential_scope', 'the step has no pinned tools on this server');
    let tools: PinnedTool[] | null = null;
    let liveDigest = /^[0-9a-f]{64}$/.test(body.liveDigest) ? body.liveDigest : 'invalid';
    if (body.tools) {
      try {
        tools = pinnedToolsOf(body.tools);
        // Never trust the node's digest when it sent the list: recompute from what we store.
        liveDigest = toolsDigest(grantedTools(tools, pin.granted));
      } catch (e) {
        if (e instanceof McpPinError) throw new HttpError(422, e.code, 'tool list refused');
        throw e;
      }
    }
    await this.reportChange({
      runId,
      actor: `node:${s.nodeId}`,
      definition,
      scope: { tenantId: s.tenantId, teamId: run.teamId, agentId: run.agentId },
      server: body.server,
      liveDigest,
      tools,
    });
  }
}
