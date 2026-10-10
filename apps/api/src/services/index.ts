import type { AppContext } from '../context.js';
import { createMcpOauth, type McpOauthStores, type TrustedRole } from '../mcp-oauth/index.js';
import { AgentCheckService } from './agent-check.js';
import { AgentSummaryService } from './agent-summaries.js';
import { AgentsService } from './agents.js';
import { AuditService } from './audit.js';
import { BudgetsService } from './budgets.js';
import { CatalogService } from './catalog.js';
import { ControlPlaneService } from './control-plane.js';
import { CostsService } from './costs.js';
import { GuidelinesService } from './guidelines.js';
import { IdentityService } from './identity.js';
import { IngestService } from './ingest.js';
import { ModelAccountingService } from './model-accounting.js';
import { ModelProxyService } from './model-proxy.js';
import { McpOauthService } from './mcp-oauth.js';
import { McpRelayService } from './mcp-relay.js';
import { McpTestService } from './mcp-test.js';
import { McpToolsService } from './mcp-tools.js';
import { ModelsService } from './models.js';
import { PentestService } from './pentest.js';
import { RunNodesService } from './run-nodes.js';
import { RunsService } from './runs.js';
import { SubtreeScopes } from './subtree-scope.js';
import { AccessExplainService } from './access-explain.js';
import { TenantRoleBindingsService } from './tenant-role-bindings.js';
import { TenantsService } from './tenants.js';

export interface Services {
  audit: AuditService;
  budgets: BudgetsService;
  identity: IdentityService;
  agents: AgentsService;
  agentSummaries: AgentSummaryService;
  catalog: CatalogService;
  runs: RunsService;
  ingest: IngestService;
  control: ControlPlaneService;
  runNodes: RunNodesService;
  modelAccounting: ModelAccountingService;
  modelProxy: ModelProxyService;
  costs: CostsService;
  guidelines: GuidelinesService;
  tenants: TenantsService;
  roleBindings: TenantRoleBindingsService;
  /** Notices, session audit and expiry reaper of the `pentest` role (ADR 0014 S6). */
  pentest: PentestService;
  accessExplain: AccessExplainService;
  models: ModelsService;
  mcpTest: McpTestService;
  mcpTools: McpToolsService;
  mcpRelay: McpRelayService;
  agentCheck: AgentCheckService;
  /** Key service, encrypted token stores and credentials of MCP OAuth (ADR 0016 S5). */
  mcpOauth: McpOauthStores;
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
  const agentSummaries = new AgentSummaryService(ctx);
  const budgets = new BudgetsService(ctx, audit, agents);
  const runs = new RunsService(ctx, audit, agents, budgets);
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
  const mcpOauthFlows = new McpOauthService(ctx, audit, catalog, runNodes, mcpOauth);
  mcpOauthFlows.principalFor = async (userId, tenantId) =>
    identity.actingIn(await identity.principalForUser(userId), tenantId);
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
    agentSummaries,
    catalog,
    runs,
    ingest,
    control,
    runNodes,
    modelAccounting,
    modelProxy,
    costs,
    guidelines,
    tenants,
    roleBindings: new TenantRoleBindingsService(ctx, audit, identity, pentest),
    pentest,
    accessExplain: new AccessExplainService(ctx),
    models,
    mcpTest,
    mcpTools,
    mcpRelay,
    agentCheck,
    mcpOauth,
    mcpOauthFlows,
    subtree: new SubtreeScopes(ctx),
  };
}

export {
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
  TenantRoleBindingsService,
  TenantsService,
};
