import type { AppContext } from '../context.js';
import { AgentCheckService } from './agent-check.js';
import { AgentsService } from './agents.js';
import { AuditService } from './audit.js';
import { BudgetsService } from './budgets.js';
import { CatalogService } from './catalog.js';
import { ControlPlaneService } from './control-plane.js';
import { CostsService } from './costs.js';
import { GuidelinesService } from './guidelines.js';
import { IdentityService } from './identity.js';
import { IngestService } from './ingest.js';
import { ModelsService } from './models.js';
import { RunNodesService } from './run-nodes.js';
import { RunsService } from './runs.js';
import { TenantsService } from './tenants.js';

export interface Services {
  audit: AuditService;
  budgets: BudgetsService;
  identity: IdentityService;
  agents: AgentsService;
  catalog: CatalogService;
  runs: RunsService;
  ingest: IngestService;
  control: ControlPlaneService;
  runNodes: RunNodesService;
  costs: CostsService;
  guidelines: GuidelinesService;
  tenants: TenantsService;
  models: ModelsService;
  agentCheck: AgentCheckService;
}

export function createServices(ctx: AppContext): Services {
  const audit = new AuditService(ctx);
  const identity = new IdentityService(ctx, audit);
  const catalog = new CatalogService(ctx, audit);
  const agents = new AgentsService(ctx, audit, catalog);
  const budgets = new BudgetsService(ctx, audit, agents);
  const runs = new RunsService(ctx, audit, agents, budgets);
  const ingest = new IngestService(ctx, audit, runs);
  const guidelines = new GuidelinesService(ctx, audit);
  const runNodes = new RunNodesService(ctx, audit, agents, catalog);
  const control = new ControlPlaneService(
    ctx,
    audit,
    agents,
    catalog,
    budgets,
    runNodes,
    guidelines,
  );
  const costs = new CostsService(ctx);
  const tenants = new TenantsService(ctx, audit, identity);
  const models = new ModelsService(ctx, catalog, audit);
  const agentCheck = new AgentCheckService(ctx, audit, catalog, models, budgets);
  return {
    audit,
    budgets,
    identity,
    agents,
    catalog,
    runs,
    ingest,
    control,
    runNodes,
    costs,
    guidelines,
    tenants,
    models,
    agentCheck,
  };
}

export {
  AgentCheckService,
  GuidelinesService,
  AgentsService,
  AuditService,
  BudgetsService,
  CatalogService,
  ControlPlaneService,
  CostsService,
  IdentityService,
  IngestService,
  ModelsService,
  RunNodesService,
  RunsService,
  TenantsService,
};
