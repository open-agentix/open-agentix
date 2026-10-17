import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import { buildApp } from './http/app.js';
import { seedDemo } from './demo/seed.js';
import { createServices, type Services } from './services/index.js';

/** Seconds between two passes of the purge of issued secret values. */
const ISSUED_PURGE_SECONDS = 900;

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
  // ADR 0014 S2: which source authorises. `legacy` unless an operator switched after a clean reconcile.
  ctx.logger.info(
    { roleBindingsRead: config.auth.roleBindingsRead },
    config.auth.roleBindingsRead === 'bindings'
      ? 'role authorisation reads tenant_role_bindings (OAX_ROLE_BINDINGS_READ=bindings)'
      : 'role authorisation reads users.global_roles (OAX_ROLE_BINDINGS_READ=legacy)',
  );
  // ADR 0014 S9: restrictions are the one kind of grant data whose loss widens access. Stored ones
  // that the legacy read path ignores are loud: error, metric, and /readyz fails (see there).
  const unenforced = await services.roleRestrictions.countUnenforced().catch((err: unknown) => {
    // unknown is not "none": /readyz treats a failing count as not ready on the legacy read path
    ctx.logger.error({ err }, 'could not count stored role restrictions');
    return 0;
  });
  ctx.metrics.unenforcedRestrictions.set(unenforced);
  if (unenforced > 0)
    ctx.logger.error(
      { restrictions: unenforced, allowed: config.auth.allowUnenforcedRestrictions },
      'role restrictions are stored but NOT enforced: OAX_ROLE_BINDINGS_READ=legacy ignores them; ' +
        'switch to bindings, or set OAX_ALLOW_UNENFORCED_RESTRICTIONS=1 to accept this',
    );
  // ADR 0017 S3: approval at publish is only checked race-free on the resolver read path; with
  // `legacy` a publish where approval is required is refused (409 role_bindings_read_required).
  if (config.auth.roleBindingsRead !== 'bindings' && config.lifecycle.requireApproval !== 'off')
    ctx.logger.warn(
      { requireApproval: config.lifecycle.requireApproval },
      'agent publish is refused wherever approval is required: it needs OAX_ROLE_BINDINGS_READ=bindings ' +
        '(or OAX_LIFECYCLE_REQUIRE_APPROVAL=off while there is no second person to approve)',
    );
  await services.identity.ensureBootstrapAdmin();
  // ADR 0017 S1: every agent from before the draft revisions gets its one system revision.
  await services.agentReviews.backfillRevisions().then(
    (n) => n > 0 && ctx.logger.info({ agents: n }, 'draft revisions created for existing agents'),
    (e: unknown) => ctx.logger.error({ err: e }, 'draft revision backfill failed'),
  );
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

  // ADR 0014 S6: delete expired bindings, 24 h and expiry notices. Expiry itself is evaluated on
  // every request; the reaper only tidies up and tells people. Stopped with the app.
  await services.pentest.runOnce().catch((e: unknown) => {
    ctx.logger.error({ err: e }, 'binding reaper failed');
  });
  services.pentest.start(config.tenancy.bindingReaperIntervalSeconds);
  // Sealed copies of issued secret values are deleted a day after their session expired.
  services.secretRotation.startPurge(ISSUED_PURGE_SECONDS);

  return { ctx, services, app };
}
