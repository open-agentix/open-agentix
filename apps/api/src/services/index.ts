import type { AppContext } from '../context.js';
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
  costs: CostsService;
  guidelines: GuidelinesService;
  tenants: TenantsService;
  models: ModelsService;
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
  const control = new ControlPlaneService(ctx, audit, agents, catalog, budgets, guidelines);
  const costs = new CostsService(ctx);
  const tenants = new TenantsService(ctx, audit, identity);
  const models = new ModelsService(ctx, catalog, audit);
  return {
    audit,
    budgets,
    identity,
    agents,
    catalog,
    runs,
    ingest,
    control,
    costs,
    guidelines,
    tenants,
    models,
  };
}

export {
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
  RunsService,
  TenantsService,
};
