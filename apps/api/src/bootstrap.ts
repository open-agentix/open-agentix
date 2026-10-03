import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import { buildApp } from './http/app.js';
import { createServices, type Services } from './services/index.js';

export interface ControlNode {
  ctx: AppContext;
  services: Services;
  app: FastifyInstance;
}

/** Builds the full control node (context, services, HTTP app) and creates the bootstrap admin. */
export async function createControlNode(
  config: Config,
  overrides: Partial<AppContext> = {},
): Promise<ControlNode> {
  const ctx = await createContext(config, overrides);
  const services = createServices(ctx);
  await services.identity.ensureBootstrapAdmin();
  const app = await buildApp({ ctx, services });
  return { ctx, services, app };
}
