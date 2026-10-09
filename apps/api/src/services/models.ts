import {
  CATALOG_PROVIDER_FOR,
  ProviderRegistry,
  ProviderSettingsSchema,
  UnavailableProvider,
  createProvider,
  modelPriceEntries,
  secretRefsOf,
  withName,
  type ModelEntry,
  type ModelProvider,
  type ProviderConfig,
  type ProviderKind,
} from '@openagentix/providers';
import { CostModel, type PriceEntry, type TenantActor } from '@openagentix/core';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { CatalogService, ConnectionRow, RunScope } from './catalog.js';

const ADAPTER_KIND: Record<string, ProviderKind> = {
  anthropic: 'anthropic',
  bedrock: 'bedrock',
  ollama: 'ollama',
  simulated: 'simulated',
};

/** Settings of a stored `model` connection bound to the connection name. */
export function connectionProviderConfig(
  row: Pick<ConnectionRow, 'name' | 'config'>,
): ProviderConfig {
  return withName(ProviderSettingsSchema.parse(row.config), row.name);
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  error: string | null;
}

/**
 * Resolves the model providers a run may use: platform providers from `OAX_PROVIDERS` plus the
 * `model` connections of the run's tenant (most specific scope wins: agent, team, tenant, platform).
 * Keys are secret references resolved here, per run, never stored or logged.
 */
export class ModelsService {
  private platform: Promise<ProviderRegistry> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  /** Providers of `OAX_PROVIDERS` (built once, secrets resolved at first use). */
  platformRegistry(): Promise<ProviderRegistry> {
    this.platform ??= ProviderRegistry.create(this.ctx.config.providers, {
      secrets: this.ctx.secrets,
      fetchImpl: this.ctx.fetchImpl,
    });
    return this.platform;
  }

  /** Tenant-scoped connections must not reach private destinations (SSRF); platform ones may. */
  private guardFor(row: Pick<ConnectionRow, 'scope'>) {
    return row.scope !== 'platform'
      ? {
          blockPrivateDestinations: {
            allow: this.ctx.config.modelProxy.privateAllow,
            ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
          },
        }
      : {};
  }

  private async build(rows: readonly ConnectionRow[]): Promise<ProviderRegistry> {
    const providers = [];
    for (const row of rows) {
      const cfg = connectionProviderConfig(row);
      try {
        providers.push(
          await createProvider(cfg, {
            secrets: this.ctx.secrets,
            fetchImpl: this.ctx.fetchImpl,
            ...this.guardFor(row),
          }),
        );
      } catch (e) {
        this.ctx.logger.warn(
          { connection: row.name, err: (e as Error).message },
          'model connection unavailable',
        );
        providers.push(
          new UnavailableProvider(
            row.name,
            ADAPTER_KIND[cfg.kind] ?? 'openai',
            (e as Error).message,
          ),
        );
      }
    }
    return ProviderRegistry.of(providers);
  }

  /**
   * The one provider a model call uses, resolved for the run's scope exactly like `registryFor`
   * (a connection of the run's tenant wins over a platform provider of the same name), together
   * with its settings. Only the requested provider is built, so only its secrets are resolved.
   * `null` when no provider of that name applies to the scope: another tenant's connections are
   * never visible here (the scope carries the tenant of the run row).
   */
  async resolve(
    scope: RunScope,
    name: string,
    /**
     * Proxy settings: no provider-level retries (a retry is a second billed call under one
     * reservation; the node retries with a new reservation) and an HTTP timeout tied to the call
     * deadline.
     */
    opts: { timeoutMs?: number } = {},
  ): Promise<{
    provider: ModelProvider;
    config: ProviderConfig | null;
    tenantControlled: boolean;
  } | null> {
    const tune = <T extends ProviderConfig>(c: T): T => ({
      ...c,
      maxRetries: 0,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const row = (await this.catalog.connectionsForRun('model', scope, { fresh: true })).find(
      (r) => r.name === name,
    );
    if (row) {
      const config = tune(connectionProviderConfig(row));
      try {
        return {
          provider: await createProvider(config, {
            secrets: this.ctx.secrets,
            fetchImpl: this.ctx.fetchImpl,
            ...this.guardFor(row),
          }),
          config,
          tenantControlled: row.scope !== 'platform',
        };
      } catch (e) {
        return {
          provider: new UnavailableProvider(
            row.name,
            ADAPTER_KIND[config.kind] ?? 'openai',
            (e as Error).message,
          ),
          config,
          tenantControlled: row.scope !== 'platform',
        };
      }
    }
    const platformCfg = this.ctx.config.providers.find((p) => p.name === name);
    if (!platformCfg) return null;
    // A fresh instance with the proxy settings (the shared platform registry keeps its own).
    const config = tune(platformCfg);
    try {
      return {
        provider: await createProvider(config, {
          secrets: this.ctx.secrets,
          fetchImpl: this.ctx.fetchImpl,
        }),
        config,
        tenantControlled: false,
      };
    } catch (e) {
      return {
        provider: new UnavailableProvider(
          name,
          ADAPTER_KIND[config.kind] ?? 'openai',
          (e as Error).message,
        ),
        config,
        tenantControlled: false,
      };
    }
  }

  /**
   * Resolved secret values of a provider's settings (key, header secrets), for scrubbing provider
   * error text before it is returned, logged or audited. Values never leave the control node.
   */
  async secretValues(config: ProviderConfig | null): Promise<string[]> {
    if (!config) return [];
    const out: string[] = [];
    for (const ref of secretRefsOf(config)) {
      try {
        const v = await this.ctx.secrets.resolve(ref);
        if (v) out.push(v);
      } catch {
        // an unresolvable reference has nothing to scrub
      }
    }
    return out;
  }

  async registryFor(scope: RunScope): Promise<ProviderRegistry> {
    const rows = await this.catalog.connectionsForRun('model', scope);
    return (await this.platformRegistry()).with(await this.build(rows));
  }

  /** Base prices (catalog + `OAX_PRICE_TABLE`) plus the price overrides of the run's connections. */
  async costModelFor(scope: RunScope): Promise<CostModel> {
    const rows = await this.catalog.connectionsForRun('model', scope);
    const extra = rows.flatMap((r) =>
      modelPriceEntries(r.name, (r.config as { models?: ModelEntry[] }).models),
    );
    return extra.length
      ? new CostModel([...this.ctx.costModel.entries(), ...extra], false)
      : this.ctx.costModel;
  }

  /**
   * Price of a model for a run's scope, looked up like the executor always did: under the provider
   * (connection) name, then under the connection's catalog provider, then under the adapter kind.
   * Includes the price overrides of the run's connections.
   */
  async priceFor(
    scope: RunScope,
    provider: string,
    model: string,
  ): Promise<PriceEntry | undefined> {
    // Overrides count only under the name of the connection the agent actually uses (the one
    // that wins for this scope). The fallback keys (catalog provider, adapter kind) are looked up
    // in the platform table alone, so a tenant connection that happens to be named like a catalog
    // provider cannot rewrite the platform price of another connection.
    const rows = await this.catalog.connectionsForRun('model', scope);
    const own = rows.find((r) => r.name === provider);
    if (own) {
      const ownEntries = modelPriceEntries(
        own.name,
        (own.config as { models?: ModelEntry[] }).models,
      );
      const hit = new CostModel(ownEntries, false).find(provider, model);
      if (hit) return hit;
    }
    const keys = [provider];
    try {
      const registry = await this.registryFor(scope);
      if (registry.has(provider)) {
        const p = registry.get(provider);
        if (p.catalogProvider) keys.push(p.catalogProvider);
        keys.push(p.kind);
      }
    } catch {
      // a broken connection only loses the fallback keys
    }
    for (const key of keys) {
      const entry = this.ctx.costModel.find(key, model);
      if (entry) return entry;
    }
    return undefined;
  }

  /** Catalog provider id a connection maps to (for proposals and price lookups). */
  catalogProviderOf(row: Pick<ConnectionRow, 'config'>): string | null {
    const cfg = ProviderSettingsSchema.parse(row.config);
    return cfg.catalogProvider ?? CATALOG_PROVIDER_FOR[cfg.kind];
  }

  /** One tiny completion to prove that the endpoint, the key reference and the model work. */
  async test(actor: TenantActor, id: string, model: string): Promise<ConnectionTestResult> {
    const row = await this.catalog.getConnection(actor, id);
    if (row.kind !== 'model') throw notFound('model connection');
    const started = Date.now();
    let result: ConnectionTestResult;
    try {
      const provider = await createProvider(connectionProviderConfig(row), {
        secrets: this.ctx.secrets,
        fetchImpl: this.ctx.fetchImpl,
        ...this.guardFor(row),
      });
      const res = await provider.complete({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxTokens: 16,
      });
      const cost = (
        await this.costModelFor({ tenantId: row.tenantId, teamId: null, agentId: '' })
      ).modelCall(row.name, model, res.usage);
      result = {
        ok: true,
        latencyMs: Date.now() - started,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costMicros: cost.totalMicros,
        error: null,
      };
    } catch (e) {
      result = {
        ok: false,
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        error: (e as Error).message.slice(0, 300),
      };
    }
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'connection.tested',
      target: id,
      payload: { model, ok: result.ok, error: result.error },
    });
    return result;
  }
}
