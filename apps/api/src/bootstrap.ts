import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import { buildApp } from './http/app.js';
import { seedDemo } from './demo/seed.js';
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
  if (config.demo.enabled) {
    const r = await seedDemo(ctx, services, { password: config.demo.password });
    ctx.logger.info(r, 'demo mode: seed checked');
  }
  const app = await buildApp({ ctx, services });
  // ADR 0014 S1 (#216): repair the bindings mirror of rows an older application version wrote
  // without it, once now and then periodically; stopped with the app.
  if (config.auth.roleBindingsReconcile) {
    await services.identity.reconciler.runAll('startup');
    services.identity.reconciler.start(config.auth.roleBindingsReconcileIntervalSeconds * 1000);
  }

  return { ctx, services, app };
}
