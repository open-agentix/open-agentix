import type { AppContext } from '../context.js';
import { AgentsService } from './agents.js';
import { AuditService } from './audit.js';
import { CatalogService } from './catalog.js';
import { ControlPlaneService } from './control-plane.js';
import { CostsService } from './costs.js';
import { IdentityService } from './identity.js';
import { IngestService } from './ingest.js';
import { RunsService } from './runs.js';

export interface Services {
  audit: AuditService;
  identity: IdentityService;
  agents: AgentsService;
  catalog: CatalogService;
  runs: RunsService;
  ingest: IngestService;
  control: ControlPlaneService;
  costs: CostsService;
}

export function createServices(ctx: AppContext): Services {
  const audit = new AuditService(ctx);
  const identity = new IdentityService(ctx, audit);
  const agents = new AgentsService(ctx, audit);
  const catalog = new CatalogService(ctx, audit);
  const runs = new RunsService(ctx, audit, agents);
  const ingest = new IngestService(ctx, audit, runs);
  const control = new ControlPlaneService(ctx, audit, agents, catalog);
  const costs = new CostsService(ctx);
  return { audit, identity, agents, catalog, runs, ingest, control, costs };
}

export {
  AgentsService,
  AuditService,
  CatalogService,
  ControlPlaneService,
  CostsService,
  IdentityService,
  IngestService,
  RunsService,
};
