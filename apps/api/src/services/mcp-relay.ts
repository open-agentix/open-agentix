import { createHash } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  OaxError,
  auditShapeOfReport,
  contextGuardFromEnv,
  findGrant,
  verifyRunToken,
  type AgentDefinition,
  type AgentSpec,
  type PublishedDefinition,
  type RunTokenClaims,
  type SecretResolver,
  type ToolCallRequest,
} from '@openagentix/core';
import {
  McpServerConfigSchema,
  RELAY_METHODS,
  RELAY_RPC,
  RELAY_UNSUPPORTED_CLIENT_METHODS,
  RelayMessageSchema,
  ToolGateway,
  relayError,
  relayMethodClass,
  type McpServerConfig,
  type RelayMessage,
} from '@openagentix/mcp';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';
import { getNetworkSettings } from '../airgap.js';
import type { AppContext } from '../context.js';
import { auditLog, type runNodeSessions, type runs } from '../db/schema.js';
import { HttpError, mcpRelayRefusal } from '../errors.js';
import type { AuditService } from './audit.js';
import type { CatalogService, ConnectionRow } from './catalog.js';
import type { ControlPlaneService } from './control-plane.js';
import type { McpToolsService } from './mcp-tools.js';
import { RelaySessions, relaySessionKey, type RelaySession } from './mcp-relay-sessions.js';
import { initializeResult, toolCallResult, toolsListResult } from './mcp-relay-results.js';
import type { RunNodesService } from './run-nodes.js';
import { VERSION } from '../version.js';

type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;

/** What one request of a run node resolved to: its session, step, and the connection it names. */
interface Target {
  claims: RunTokenClaims;
  node: typeof runNodeSessions.$inferSelect;
  run: typeof runs.$inferSelect;
  definition: AgentDefinition;
  agentId: string;
  agent: AgentSpec;
  server: string;
  row: ConnectionRow;
  cfg: HttpConfig;
  platform: boolean;
}

export interface RelayRequest {
  token: string;
  runId: string;
  server: string;
  /** The parsed JSON body; validated here. */
  body: unknown;
  traceparent?: unknown;
  /** Aborted when the node goes away: the upstream call is cancelled with it. */
  signal: AbortSignal;
}

export type RelayAnswer = { status: 200; body: unknown } | { status: 202 };

/** One answer plus the closed outcome label for the metric. */
interface Dispatched {
  answer: RelayAnswer;
  outcome: string;
}

const refused = mcpRelayRefusal;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const OAX_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Refusals audited per node session: a node that probes names cannot flood the audit log. */
const MAX_REFUSAL_AUDITS = 20;
/** Entries of the audit budget map before it is reset (bounded memory). */
const MAX_AUDIT_BUDGETS = 2000;
const CALL_PARAM_KEYS: ReadonlySet<string> = new Set(['name', 'arguments', '_meta']);

const deadline = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OaxError('tool_timeout', 'the MCP call timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The control-node MCP relay (ADR 0016 section 6, decides ADR 0012 open question 2).
 *
 * A run node never connects to an HTTP MCP server and never holds its header secrets or tokens:
 * its MCP client posts JSON-RPC messages here with the step-scoped run token. Every request is
 * checked against the live node session, the step's own grants and the stored connection; a
 * `tools/call` gets the same policy decision, approval, tool pin and guard as the in-process path
 * (the same {@link ToolGateway}), and leaves through the same dispatcher (purpose `mcp`, SSRF
 * rules of ADR 0011). Anything the node must not learn the reason of is answered like an unknown
 * server.
 */
export class McpRelayService {
  private readonly sessions: RelaySessions;
  private outbound: OutboundDispatcher | undefined;
  private readonly refusalAudits = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly control: ControlPlaneService,
    private readonly runNodes: RunNodesService,
    private readonly mcpTools: McpToolsService,
  ) {
    const relay = ctx.config.mcp.relay;
    this.sessions = new RelaySessions(
      relay,
      () => this.ctx.now().getTime(),
      (open) => this.ctx.metrics.mcpRelaySessions.set(open),
    );
    // A revoked node session ends the relay sessions of its run on this replica; on other
    // replicas they idle out, and every request is checked against the database anyway.
    runNodes.onRevoked((s) => this.sessions.dropRun(s.runId));
  }

  /** Open relay sessions on this replica (tests, metrics). */
  get openSessions(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    await this.sessions.closeAll();
    if (!this.ctx.mcpOutbound) await this.outbound?.close().catch(() => undefined);
    this.outbound = undefined;
  }

  async handle(req: RelayRequest): Promise<RelayAnswer> {
    let method = 'other';
    let outcome = 'error';
    try {
      const target = await this.resolve(req);
      const message = this.parse(req.body);
      method = relayMethodClass(message.method);
      const done = await this.dispatch(target, message, req.signal);
      outcome = done.outcome;
      return done.answer;
    } catch (e) {
      outcome = this.outcomeOf(e);
      throw e;
    } finally {
      this.ctx.metrics.mcpRelayRequest(method, outcome);
    }
  }

  // ---------- who is asking, and for what ----------

  /**
   * Token, node session, run, step, connection. Every failure up to the connection is the same
   * refusal as an unknown server: a revoked or expired session, a token of another run, a server
   * the step has no grant on and a connection of another tenant look identical to the node.
   */
  private async resolve(req: RelayRequest): Promise<Target> {
    let claims: RunTokenClaims;
    let node: Target['node'];
    try {
      claims = verifyRunToken(this.ctx.config.runToken.secret, req.token, this.ctx.now().getTime());
      if (claims.runId !== req.runId || !claims.sid || claims.steps?.length !== 1) throw refused();
      node = await this.runNodes.checkSession(claims, req.runId, req.traceparent);
    } catch {
      throw refused();
    }
    const { run, definition } = await this.runNodes.runContext(req.runId);
    const agentId = claims.steps![0]!;
    const agent = definition.agents.find((a) => a.id === agentId);
    if (run.tenantId !== node.tenantId || !agent) throw refused();
    const reason = await this.connectionOf(run, agent, req.server);
    if (typeof reason === 'string') {
      await this.auditRefusal(node, agentId, req.server, reason);
      throw refused();
    }
    return { claims, node, run, definition, agentId, agent, server: req.server, ...reason };
  }

  /** The step's HTTP connection named `server`, or the reason there is none (audit only). */
  private async connectionOf(
    run: Target['run'],
    agent: AgentSpec,
    server: string,
  ): Promise<{ row: ConnectionRow; cfg: HttpConfig; platform: boolean } | string> {
    if (!this.runNodes.serversOf(agent).has(server)) return 'not_granted';
    const scope = { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId };
    // Fresh read: a connection that was removed, retargeted or re-keyed since the step began counts.
    const row = (await this.catalog.connectionsForRun('mcp', scope, { fresh: true })).find(
      (c) => c.name === server,
    );
    if (!row) return 'unknown_connection';
    const parsed = McpServerConfigSchema.safeParse(row.config);
    if (!parsed.success || parsed.data.transport !== 'streamable-http') return 'not_http';
    return { row, cfg: parsed.data, platform: row.scope === 'platform' };
  }

  private parse(body: unknown): RelayMessage {
    const parsed = RelayMessageSchema.safeParse(body);
    if (!parsed.success)
      throw new HttpError(400, 'mcp_relay_invalid', 'the request is not a JSON-RPC 2.0 message');
    return parsed.data;
  }

  private async auditRefusal(
    node: Target['node'],
    agentId: string,
    server: string,
    reason: string,
  ): Promise<void> {
    if (this.refusalAudits.size > MAX_AUDIT_BUDGETS) this.refusalAudits.clear();
    const used = this.refusalAudits.get(node.id) ?? 0;
    if (used >= MAX_REFUSAL_AUDITS) return;
    this.refusalAudits.set(node.id, used + 1);
    await this.audit.append({
      actor: `node:${node.nodeId}`,
      tenantId: node.tenantId,
      action: 'mcp.relay.refused',
      target: server.slice(0, 64),
      runId: node.runId,
      payload: { runId: node.runId, nodeId: node.nodeId, agentId, reason },
    });
  }

  // ---------- methods ----------

  private async dispatch(t: Target, msg: RelayMessage, outer: AbortSignal): Promise<Dispatched> {
    const isRequest = msg.id !== undefined;
    const ok = (body: unknown): Dispatched => ({ answer: { status: 200, body }, outcome: 'ok' });
    const reject = (code: number, oax: string, outcome: string, text: string): Dispatched => {
      if (!isRequest) throw new HttpError(400, oax, text);
      return {
        answer: { status: 200, body: relayError(msg.id!, code, text, oax) },
        outcome,
      };
    };
    if (RELAY_UNSUPPORTED_CLIENT_METHODS.has(msg.method))
      return reject(
        RELAY_RPC.methodNotFound,
        'mcp_capability_unsupported',
        'unsupported',
        'sampling, elicitation and roots are not relayed',
      );
    if (!RELAY_METHODS.has(msg.method))
      return reject(
        RELAY_RPC.methodNotFound,
        'mcp_method_not_allowed',
        'refused',
        'this MCP method is not relayed',
      );
    if (msg.method.startsWith('notifications/')) {
      if (isRequest) throw new HttpError(400, 'mcp_relay_invalid', 'a notification has no id');
      return { answer: { status: 202 }, outcome: 'ok' };
    }
    if (!isRequest) throw new HttpError(400, 'mcp_relay_invalid', 'a request needs an id');
    const result = (value: unknown): Dispatched =>
      ok({ jsonrpc: '2.0', id: msg.id, result: value });
    if (msg.method === 'ping') return result({});
    if (msg.method === 'initialize') return result(initializeResult(msg.params, VERSION));
    try {
      return result(await this.withSession(t, outer, (s, signal) => this.run(t, msg, s, signal)));
    } catch (e) {
      return this.failure(t, msg.id!, e);
    }
  }

  /** Session lookup (keyed by credential version), slot, hard deadline; then `work`. */
  private async withSession<T>(
    t: Target,
    outer: AbortSignal,
    work: (session: RelaySession, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const resolver = await this.resolverOf(t);
    const key = relaySessionKey(
      t.run.tenantId,
      t.row.id,
      await this.credentialVersion(t, resolver),
      t.run.id,
    );
    const session = await this.sessions.getOrCreate(key, t.run.id, () =>
      this.createGateway(t, resolver),
    );
    const release = this.sessions.acquire(session);
    try {
      const timeoutMs = t.cfg.timeoutMs;
      // The SDK enforces `timeoutMs` per request; a call needs up to three (connect, verify, call),
      // and the deadline is the backstop that always gives the slot back.
      const hardMs = timeoutMs * 3 + 2_000;
      const signal = AbortSignal.any([outer, AbortSignal.timeout(hardMs)]);
      return await deadline(work(session, signal), hardMs);
    } finally {
      release();
    }
  }

  private async run(
    t: Target,
    msg: RelayMessage,
    session: RelaySession,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (msg.method === 'tools/list') return this.listTools(t, session);
    return this.callTool(t, msg.params ?? {}, session, signal);
  }

  private async listTools(t: Target, session: RelaySession): Promise<unknown> {
    const tools = await session.gateway.serverTools(t.server);
    // A pinned list is the verified one (exactly the tools the pin covers, the node checks the same
    // digest); any other list shows only what the step holds grants on.
    const pinned = Boolean((t.definition as PublishedDefinition).toolPins?.[t.server]);
    const visible = pinned
      ? tools
      : tools.filter((x) => findGrant(t.agent.tools, t.server, x.name));
    const guarded = session.gateway.guard.value(visible).value as typeof visible;
    const result = toolsListResult(guarded);
    if (!result)
      throw new OaxError('mcp_result_too_large', `the tool list of "${t.server}" is too large`);
    return result;
  }

  private async callTool(
    t: Target,
    params: Record<string, unknown>,
    session: RelaySession,
    signal: AbortSignal,
  ): Promise<unknown> {
    const name = params.name;
    const args = params.arguments ?? {};
    if (
      typeof name !== 'string' ||
      !TOOL_NAME.test(name) ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(params).some((k) => !CALL_PARAM_KEYS.has(k))
    )
      throw new OaxError('mcp_relay_invalid', 'tools/call needs a tool name and object arguments');
    const call: ToolCallRequest = {
      server: t.server,
      tool: name,
      args: args as Record<string, unknown>,
    };
    await this.assertAllowed(t, call);
    const started = Date.now();
    try {
      const { result, guard } = await session.gateway.execute(call, signal);
      await this.auditCall(t, call, 'ok', {
        bytes: result.bytes,
        truncated: result.truncated,
        durationMs: Date.now() - started,
        ...(guard ? { guard: auditShapeOfReport(guard) } : {}),
      });
      if (guard) this.ctx.metrics.guard('tool_result', guard.secrets.total, guard.invisible.total);
      return toolCallResult(result, t.cfg.maxResultBytes);
    } catch (e) {
      await this.auditCall(t, call, e instanceof OaxError ? e.code : 'tool_failed', {
        durationMs: Date.now() - started,
      });
      throw e;
    }
  }

  /**
   * The gate, again, on the control node: the node asked it too, but a node is not trusted to
   * have. A call that needs approval passes only with an approved approval for exactly this call,
   * used once.
   */
  private async assertAllowed(t: Target, call: ToolCallRequest): Promise<void> {
    if (!findGrant(t.agent.tools, call.server, call.tool))
      throw new OaxError('policy_denied', 'the step holds no grant for this tool');
    const decision = await this.control.evaluate(
      t.run.id,
      t.agentId,
      call,
      await this.relayedCalls(t, call),
    );
    if (decision.effect === 'allow') return;
    if (decision.effect === 'require_approval') {
      if (await this.control.consumeApproval(t.run.id, t.agentId, call)) return;
      await this.auditCall(t, call, 'approval_required', {});
      throw new OaxError('approval_required', 'this call needs an approval that was not granted');
    }
    await this.audit.append({
      actor: `node:${t.node.nodeId}`,
      tenantId: t.node.tenantId,
      action: 'mcp.relay.denied',
      target: `${call.server}/${call.tool}`,
      runId: t.run.id,
      payload: { runId: t.run.id, agentId: t.agentId, reasons: decision.reasons },
    });
    throw new OaxError('policy_denied', 'the policy gate denied this call');
  }

  /**
   * Calls of this tool the relay let through in this run, for grants with `maxCallsPerRun`. The
   * count of recorded steps comes from the node's own reports, which a compromised node can leave
   * out; the relay's audit entries are its own record.
   */
  private async relayedCalls(t: Target, call: ToolCallRequest): Promise<number> {
    const grant = findGrant(t.agent.tools, call.server, call.tool);
    if (grant?.maxCallsPerRun === undefined) return 0;
    const [row] = await this.ctx.db
      .select({ n: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.runId, t.run.id),
          eq(auditLog.action, 'mcp.relay.call'),
          eq(auditLog.target, `${call.server}/${call.tool}`),
          sql`${auditLog.payload}->>'outcome' = 'ok'`,
        ),
      );
    return Number(row?.n ?? 0);
  }

  private async auditCall(
    t: Target,
    call: ToolCallRequest,
    outcome: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actor: `node:${t.node.nodeId}`,
      tenantId: t.node.tenantId,
      action: 'mcp.relay.call',
      target: `${call.server}/${call.tool}`,
      runId: t.run.id,
      payload: { runId: t.run.id, agentId: t.agentId, outcome, ...extra },
    });
  }

  // ---------- errors ----------

  private failure(t: Target, id: string | number, e: unknown): Dispatched {
    if (e instanceof HttpError) throw e;
    const code = e instanceof OaxError && OAX_CODE.test(e.code) ? e.code : 'tool_failed';
    const outcome = this.outcomeOf(e);
    // Platform connections are the operator's: a tenant's node learns the code, not the text (it
    // can name internal addresses). A tenant's own server errors are its own business.
    const text =
      t.platform || !(e instanceof Error)
        ? `MCP server "${t.server}" failed (${code})`
        : e.message.slice(0, 500);
    const rpc =
      code === 'policy_denied' || code === 'approval_required'
        ? RELAY_RPC.refused
        : RELAY_RPC.failed;
    return { answer: { status: 200, body: relayError(id, rpc, text, code) }, outcome };
  }

  private outcomeOf(e: unknown): string {
    if (e instanceof HttpError)
      return e.statusCode === 429
        ? e.code === 'rate_limited'
          ? 'rate_limited'
          : 'busy'
        : e.statusCode === 404 || e.statusCode === 400
          ? 'refused'
          : e.statusCode === 503
            ? 'busy'
            : 'error';
    if (!(e instanceof OaxError)) return 'error';
    switch (e.code) {
      case 'policy_denied':
        return 'denied';
      case 'approval_required':
        return 'approval_required';
      case 'mcp_tools_changed':
        return 'tools_changed';
      case 'mcp_capability_unsupported':
        return 'unsupported';
      case 'tool_timeout':
        return 'timeout';
      default:
        return 'error';
    }
  }

  // ---------- upstream connection ----------

  /** Tenant connections use the tenant's secret allowlist; platform connections the operator's. */
  private async resolverOf(t: Target): Promise<SecretResolver> {
    return t.platform ? this.ctx.secrets : this.runNodes.resolverFor(t.run.tenantId);
  }

  /**
   * Identifies what the session would connect with: the stored connection (its last change) and the
   * current values of its header secrets, hashed. Rotating a secret or editing the connection
   * therefore opens a new session; the old one is never reused. Only a hash is kept.
   */
  private async credentialVersion(t: Target, resolver: SecretResolver): Promise<string> {
    const hash = createHash('sha256').update(String(t.row.updatedAt));
    try {
      for (const [header, ref] of Object.entries(t.cfg.headerSecrets).sort(([a], [b]) =>
        a < b ? -1 : 1,
      ))
        hash.update(`\0${header}\0${await resolver.resolve(ref)}`);
    } catch {
      // The reason can name a secret reference; the node learns only that credentials are missing.
      throw new OaxError(
        'mcp_credentials_unavailable',
        'the credentials of this MCP server are unavailable',
      );
    }
    return hash.digest('hex').slice(0, 32);
  }

  private dispatcher(): OutboundDispatcher {
    if (this.ctx.mcpOutbound) return this.ctx.mcpOutbound;
    const settings = getNetworkSettings();
    return (this.outbound ??= createOutboundDispatcher({
      ...(settings ? { network: settings.net } : {}),
      allowPlainHttpForPlatform: true,
    }));
  }

  /** The in-process gateway for this one connection: pins, guard, SSRF rules are all its own. */
  private async createGateway(t: Target, secrets: SecretResolver): Promise<ToolGateway> {
    const gateway = new ToolGateway(
      [t.cfg],
      {
        secrets,
        outbound: this.dispatcher(),
        originFor: () => (t.platform ? 'platform' : 'tenant'),
        ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
      },
      contextGuardFromEnv(process.env),
    );
    const scope = { tenantId: t.run.tenantId, teamId: t.run.teamId, agentId: t.run.agentId };
    const pins = await this.runNodes.pinResolver?.(t.definition, scope, new Set([t.server]));
    if (pins && Object.keys(pins).length > 0)
      gateway.pinTools(pins, async (e) =>
        this.mcpTools.reportChange({
          runId: t.run.id,
          actor: `relay:${t.node.nodeId}`,
          definition: t.definition,
          scope,
          server: e.server,
          liveDigest: e.liveDigest,
          tools: e.tools,
        }),
      );
    return gateway;
  }
}
