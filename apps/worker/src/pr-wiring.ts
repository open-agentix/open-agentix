import { readFileSync } from 'node:fs';
import { getNetworkSettings, type AppContext, type Config, type Services } from '@openagentix/api';
import { createOutboundDispatcher } from '@openagentix/providers';
import {
  PullRequestDelivery,
  loadPullRequestTargets,
  type PullRequestDeliveryOptions,
} from './git/index.js';

/** Platform secrets that must never appear in text leaving through a pull request. */
export function platformSecretValues(config: Config): string[] {
  const c = config as unknown as {
    runToken: { secret: string };
    database: { password?: string | undefined };
    auth?: {
      bootstrapAdmin?: { password: string } | null;
      oidc?: { clientSecret?: string | undefined } | null;
      ldap?: { bindPassword?: string | undefined } | null;
    };
    runners?: { container?: { config?: { egressGrantSecret?: string } | null } };
  };
  return [
    c.runToken?.secret,
    c.database?.password,
    c.auth?.bootstrapAdmin?.password,
    c.auth?.oidc?.clientSecret,
    c.auth?.ldap?.bindPassword,
    c.runners?.container?.config?.egressGrantSecret,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

/** Writes delivery audit events (codes, digests, counts) to the audit chain of their run. */
export function deliveryAuditSink(
  services: Pick<Services, 'audit'>,
  workerId: string,
): NonNullable<PullRequestDeliveryOptions['audit']> {
  return async ({ action, runId, target, at: _at, ...payload }) => {
    await services.audit.append({
      actor: `worker:${workerId}`,
      action,
      target,
      runId,
      payload,
    });
  };
}

/**
 * Builds the pull request delivery from `OAX_PR_TARGETS` (a JSON file chosen by the operator;
 * unset: the feature is off and a step with a `pull-request` output fails closed). `OAX_PR_DRY_RUN`
 * stops every delivery after the local commit. Audit entries go to the audit chain of the run.
 */
export function createPullRequestDelivery(
  ctx: AppContext,
  services: Services,
  workerId: string,
  env: NodeJS.ProcessEnv = process.env,
): PullRequestDelivery | undefined {
  const file = env.OAX_PR_TARGETS;
  if (!file) return undefined;
  const targets = loadPullRequestTargets(file, (p) => readFileSync(p, 'utf8'));
  const settings = getNetworkSettings();
  const dispatcher = createOutboundDispatcher({
    ...(settings ? { network: settings.net } : {}),
  });
  const privateAllow = (env.OAX_PR_PRIVATE_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const github = { ...(privateAllow.length ? { privateAllow } : {}) };
  return new PullRequestDelivery({
    dispatcher,
    secrets: ctx.secrets,
    targets,
    dryRun: env.OAX_PR_DRY_RUN === 'true',
    github,
    engine: { ...(privateAllow.length ? { privateAllow } : {}) },
    knownSecrets: async (runId) => {
      const out = new Set<string>(platformSecretValues(ctx.config));
      for (const v of await services.runNodes.knownSecrets(runId).catch(() => [])) out.add(v);
      for (const ref of await services.runNodes.platformSecretRefs().catch(() => new Set<string>()))
        try {
          out.add(await ctx.secrets.resolve(ref));
        } catch {
          // not resolvable: nothing to keep out
        }
      return [...out].filter((v) => v.length >= 8);
    },
    audit: deliveryAuditSink(services, workerId),
  });
}
