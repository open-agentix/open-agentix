import { hasPermissionIn } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents } from '../db/schema.js';
import { createMcpOauth, type McpOauthStores, type TrustedRole } from '../mcp-oauth/index.js';
import { AgentCheckService } from './agent-check.js';
import { AgentDeprecationService } from './agent-deprecation.js';
import { AgentPublisher } from './agent-publish.js';
import { AgentReviewsService } from './agent-reviews.js';
import { PublishGate } from './publish-gate.js';
import { ReviewChangesService } from './review-changes.js';
import { ReviewInboxService } from './review-inbox.js';
import { ReviewThreadsService } from './review-threads.js';
import { AgentSummaryService } from './agent-summaries.js';
import { AgentsService } from './agents.js';
import { AuditService } from './audit.js';
import { BudgetsService } from './budgets.js';
import { CatalogService } from './catalog.js';
import { ControlPlaneService } from './control-plane.js';
import { CostsService } from './costs.js';
import { DevRunsService } from './dev-runs.js';
import { GuidelinesService } from './guidelines.js';
import { IdentityService } from './identity.js';
import { IngestService } from './ingest.js';
import { LifecyclePolicyService } from './lifecycle-policy.js';
import { LocateService } from './locate.js';
import { ModelAccountingService } from './model-accounting.js';
import { ModelProxyService } from './model-proxy.js';
import { McpOauthService } from './mcp-oauth.js';
import { McpRelayService } from './mcp-relay.js';
import { McpTestService } from './mcp-test.js';
import { McpToolsService } from './mcp-tools.js';
import { ModelsService } from './models.js';
import { PentestService } from './pentest.js';
import { RunNodesService } from './run-nodes.js';
import { ScopedSecretBroker } from './secret-broker.js';
import { SecretResolution } from './secret-resolution.js';
import { SecretKeyRotation } from './secret-rotation.js';
import { SecretStore } from './secret-store.js';
import { SecretsService } from './secrets.js';
import { RunsService } from './runs.js';
import { SubtreeScopes } from './subtree-scope.js';
import { AccessExplainService } from './access-explain.js';
import { RoleRestrictionsService } from './role-restrictions.js';
import { TenantRoleBindingsService } from './tenant-role-bindings.js';
import { TenantMoves } from './tenant-moves.js';
import { TenantsService } from './tenants.js';

export interface Services {
  audit: AuditService;
  budgets: BudgetsService;
  identity: IdentityService;
  agents: AgentsService;
  /** The agent lifecycle policy of a tenant node (ADR 0017 S1). */
  lifecyclePolicy: LifecyclePolicyService;
  /** Draft revisions, reviews and approval records (ADR 0017 S1). */
  agentReviews: AgentReviewsService;
  /** Version deprecation and rollback (ADR 0017 S3). */
  agentDeprecation: AgentDeprecationService;
  reviewThreads: ReviewThreadsService;
  reviewChanges: ReviewChangesService;
  reviewInbox: ReviewInboxService;
  agentSummaries: AgentSummaryService;
  catalog: CatalogService;
  runs: RunsService;
  /** Development runs of draft revisions (ADR 0017 S5). */
  devRuns: DevRunsService;
  ingest: IngestService;
  control: ControlPlaneService;
  runNodes: RunNodesService;
  modelAccounting: ModelAccountingService;
  modelProxy: ModelProxyService;
  costs: CostsService;
  guidelines: GuidelinesService;
  tenants: TenantsService;
  roleBindings: TenantRoleBindingsService;
  /** Role restrictions per node (ADR 0014 section 5, S9). */
  roleRestrictions: RoleRestrictionsService;
  tenantMoves: TenantMoves;
  /** Notices, session audit and expiry reaper of the `pentest` role (ADR 0014 S6). */
  pentest: PentestService;
  accessExplain: AccessExplainService;
  /** Which tenant owns a resource, for deep links (ADR 0014 S7). */
  locate: LocateService;
  models: ModelsService;
  mcpTest: McpTestService;
  mcpTools: McpToolsService;
  mcpRelay: McpRelayService;
  agentCheck: AgentCheckService;
  /** Key service, encrypted token stores and credentials of MCP OAuth (ADR 0016 S5). */
  mcpOauth: McpOauthStores;
  /** Scoped secrets: metadata API and the write-only encrypted store (ADR 0017 S4). */
  secrets: SecretsService;
  /** Operator-driven KEK and DEK rotation (used by the `db:keys` tool). */
  secretRotation: SecretKeyRotation;
  /** OAuth flows of HTTP MCP connections (authorize, renew, revoke); trusted processes only. */
  mcpOauthFlows: McpOauthService;
  subtree: SubtreeScopes;
}

/** `role` says which trusted process the services are built for (it gates `McpCredentials`). */
export function createServices(ctx: AppContext, role: TrustedRole = 'api'): Services {
  const audit = new AuditService(ctx);
  const identity = new IdentityService(ctx, audit);
  const catalog = new CatalogService(ctx, audit);
  const agents = new AgentsService(ctx, audit, catalog);
  const lifecyclePolicy = new LifecyclePolicyService(ctx, audit);
  const secretResolution = new SecretResolution(ctx);
  const agentReviews = new AgentReviewsService(
    ctx,
    audit,
    agents,
    lifecyclePolicy,
    catalog,
    secretResolution,
  );
  const publishGate = new PublishGate(ctx, agentReviews);
  agents.publisher = new AgentPublisher(ctx, audit, publishGate, lifecyclePolicy, secretResolution);
  const agentDeprecation = new AgentDeprecationService(
    ctx,
    audit,
    agents,
    agentReviews,
    lifecyclePolicy,
  );
  const reviewThreads = new ReviewThreadsService(ctx, audit, agents, agentReviews);
  const reviewChanges = new ReviewChangesService(ctx, agents, agentReviews, lifecyclePolicy);
  const reviewInbox = new ReviewInboxService(ctx, agentReviews, lifecyclePolicy);
  const agentSummaries = new AgentSummaryService(ctx);
  const budgets = new BudgetsService(ctx, audit, agents);
  const runs = new RunsService(ctx, audit, agents, budgets);
  const devRuns = new DevRunsService(ctx, audit, agents, catalog, budgets, lifecyclePolicy);
  const ingest = new IngestService(ctx, audit, runs);
  const guidelines = new GuidelinesService(ctx, audit);
  const runNodes = new RunNodesService(ctx, audit, agents, catalog);
  const models = new ModelsService(ctx, catalog, audit);
  const mp = ctx.config.modelProxy;
  const modelAccounting = new ModelAccountingService(
    ctx,
    audit,
    agents,
    budgets,
    (runId, v) => runNodes.scrub(runId, v),
    {
      maxConcurrentPerSession: mp.maxConcurrentPerSession,
      maxConcurrentPerTenant: mp.maxConcurrentPerTenant,
      graceMs: mp.graceSeconds * 1000,
      defaultDeadlineMs: mp.maxCallSeconds * 1000,
      priceFor: (scope, provider, model) => models.priceFor(scope, provider, model),
      providerLabel: (scope, name) => models.providerLabel(scope, name),
    },
  );
  const control = new ControlPlaneService(
    ctx,
    audit,
    agents,
    catalog,
    budgets,
    runNodes,
    guidelines,
    modelAccounting,
  );
  const costs = new CostsService(ctx);
  const tenants = new TenantsService(ctx, audit, identity);
  const pentest = new PentestService(ctx, audit, identity);
  const modelProxy = new ModelProxyService(ctx, audit, agents, models, modelAccounting, runNodes);
  const agentCheck = new AgentCheckService(ctx, audit, catalog, models, budgets);
  const mcpOauth = createMcpOauth(ctx, role);
  const secretStore = new SecretStore(ctx, mcpOauth.keys);
  const secrets = new SecretsService(ctx, audit, secretStore, secretResolution);
  const secretRotation = new SecretKeyRotation(ctx, audit, mcpOauth.keys, secretStore);
  runNodes.scoped = new ScopedSecretBroker(
    ctx,
    secretStore,
    secretResolution,
    lifecyclePolicy,
    (run) => starterEntitled(ctx, identity, run),
  );
  const mcpOauthFlows = new McpOauthService(ctx, audit, catalog, runNodes, mcpOauth);
  const mcpTest = new McpTestService(ctx, catalog, runNodes, audit, mcpOauthFlows);
  const mcpTools = new McpToolsService(ctx, audit, catalog, mcpTest, runNodes);
  runNodes.pinResolver = (definition, scope, servers) =>
    mcpTools.pinsFor(definition, scope, servers);
  const mcpRelay = new McpRelayService(
    ctx,
    audit,
    catalog,
    control,
    runNodes,
    mcpTools,
    mcpOauthFlows,
  );
  return {
    audit,
    budgets,
    identity,
    agents,
    lifecyclePolicy,
    agentReviews,
    agentDeprecation,
    reviewThreads,
    reviewChanges,
    reviewInbox,
    agentSummaries,
    catalog,
    runs,
    devRuns,
    ingest,
    control,
    runNodes,
    modelAccounting,
    modelProxy,
    costs,
    guidelines,
    tenants,
    roleBindings: new TenantRoleBindingsService(ctx, audit, identity, pentest),
    roleRestrictions: new RoleRestrictionsService(ctx, audit),
    tenantMoves: new TenantMoves(ctx, audit),
    pentest,
    accessExplain: new AccessExplainService(ctx),
    locate: new LocateService(ctx, audit),
    models,
    mcpTest,
    mcpTools,
    mcpRelay,
    agentCheck,
    mcpOauth,
    secrets,
    secretRotation,
    mcpOauthFlows,
    subtree: new SubtreeScopes(ctx),
  };
}

export {
  AgentReviewsService,
  LifecyclePolicyService,
  AgentCheckService,
  GuidelinesService,
  AgentsService,
  AgentSummaryService,
  AuditService,
  BudgetsService,
  CatalogService,
  ControlPlaneService,
  CostsService,
  IdentityService,
  IngestService,
  ModelAccountingService,
  ModelProxyService,
  McpOauthService,
  McpRelayService,
  McpToolsService,
  ModelsService,
  PentestService,
  RunNodesService,
  RunsService,
  SubtreeScopes,
  RoleRestrictionsService,
  TenantRoleBindingsService,
  TenantsService,
};

/**
 * Whether the user who started a development run may still use their personal secrets: the account
 * exists and is active, can still act in the run's node, and still holds `agents:write` on the agent.
 * Read at every issuance, so disabling the user or removing the role stops the secrets at once. Any
 * failure counts as "no" (fail closed).
 */
async function starterEntitled(
  ctx: AppContext,
  identity: IdentityService,
  run: { startedBy: string | null; tenantId: string; teamId: string | null; agentId: string },
): Promise<boolean> {
  if (!run.startedBy) return false;
  try {
    const home = await identity.principalForUser(run.startedBy);
    const acting =
      home.tenantId === run.tenantId ? home : await identity.actingIn(home, run.tenantId);
    const [agent] = await ctx.db
      .select({ useCase: agents.useCase })
      .from(agents)
      .where(eq(agents.id, run.agentId));
    return hasPermissionIn(acting, 'agents:write', {
      teamId: run.teamId,
      agentId: run.agentId,
      useCase: agent?.useCase ?? null,
    });
  } catch {
    return false;
  }
}
