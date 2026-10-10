import type { AppContext } from '../context.js';
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
import { McpTestService } from './mcp-test.js';
import { ModelsService } from './models.js';
import { RunNodesService } from './run-nodes.js';
import { RunsService } from './runs.js';
import { SubtreeScopes } from './subtree-scope.js';
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
  models: ModelsService;
  mcpTest: McpTestService;
  agentCheck: AgentCheckService;
  subtree: SubtreeScopes;
}

export function createServices(ctx: AppContext): Services {
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
  const modelProxy = new ModelProxyService(ctx, audit, agents, models, modelAccounting, runNodes);
  const agentCheck = new AgentCheckService(ctx, audit, catalog, models, budgets);
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
    roleBindings: new TenantRoleBindingsService(ctx, audit, identity),
    models,
    mcpTest: new McpTestService(ctx, catalog, runNodes, audit),
    agentCheck,
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
  ModelsService,
  RunNodesService,
  RunsService,
  SubtreeScopes,
  TenantRoleBindingsService,
  TenantsService,
};
