import { authKindOf, type McpServerConfig } from '@openagentix/mcp';
import { isScopedRef, type AgentDefinition, type AgentSpec } from '@openagentix/core';
import { HttpError } from '../errors.js';
import type { CatalogService } from './catalog.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';

/** What the gate needs to know about a development run. */
export interface DevRunRef {
  stage: string;
  startedBy: string | null;
  tenantId: string;
  teamId: string | null;
  agentId: string;
}

/**
 * Whether a connection carries credentials: environment secrets of a stdio server, static header
 * secrets or OAuth tokens of an HTTP server. Connections have no `usage`, so every such connection is
 * treated as a production credential (ADR 0017 section 8: drafts reach production credentials only
 * with `allowDraftRuns: on` and `allowProductionSecretsInDraftRuns`).
 */
export function connectionCarriesCredentials(cfg: McpServerConfig): boolean {
  if (cfg.transport === 'stdio') return Object.keys(cfg.envSecrets).length > 0;
  if (cfg.transport !== 'streamable-http') return false;
  const kind = authKindOf(cfg);
  return kind === 'oauth' || (kind === 'static' && Object.keys(cfg.headerSecrets).length > 0);
}

const serversOf = (agent: AgentSpec): Set<string> =>
  new Set([
    ...agent.tools.map((t) => t.server),
    ...(agent.profileGrants ?? []).map((p) => p.server),
  ]);

/**
 * The checks that keep a development run inside what its starter may do, at admission, when a worker
 * claims it, at every model reservation, node session, credential issuance and relayed MCP call (the
 * policy and the account are read each time, so a tightened policy, a disabled account or a lost role
 * stops a run that is already going):
 *
 * - draft runs are not switched off (`allowDraftRuns`);
 * - the starter is still entitled (account active, `agents:write` on the agent);
 * - the run uses no production-class credential other than scoped secrets (which have their own
 *   `usage`): legacy references (operator environment and files), the secrets of MCP connections and
 *   MCP OAuth tokens count as `production` and need `allowDraftRuns: on` together with
 *   `allowProductionSecretsInDraftRuns`.
 */
export class DevRunGate {
  constructor(
    private readonly policy: Pick<LifecyclePolicyService, 'effectiveForTenant'>,
    private readonly catalog: Pick<CatalogService, 'mcpConfigs'>,
    private readonly entitled: (run: DevRunRef) => Promise<boolean>,
  ) {}

  /** Whether production-class credentials may reach a draft at this node. */
  async allowsProductionCredentials(tenantId: string): Promise<boolean> {
    const p = await this.policy.effectiveForTenant(tenantId);
    return p.allowDraftRuns === 'on' && p.allowProductionSecretsInDraftRuns;
  }

  /** Policy and starter: `403 dev_run_not_permitted` when the run may not go on. */
  async assertActive(run: DevRunRef): Promise<void> {
    if (run.stage !== 'development') return;
    const p = await this.policy.effectiveForTenant(run.tenantId);
    if (p.allowDraftRuns === 'off')
      throw new HttpError(
        403,
        'dev_run_not_permitted',
        'development runs are switched off by the lifecycle policy',
      );
    if (!(await this.entitled(run)))
      throw new HttpError(
        403,
        'dev_run_not_permitted',
        'the person who started this development run is no longer allowed to run this draft',
      );
  }

  /**
   * Legacy references and credentialed connections of the definition, unless the policy lets drafts
   * use production credentials: `400 production_credentials_in_draft` with the references.
   */
  async assertNoProductionCredentials(
    definition: Pick<AgentDefinition, 'agents'>,
    scope: { tenantId: string; teamId: string | null; agentId: string },
  ): Promise<void> {
    if (await this.allowsProductionCredentials(scope.tenantId)) return;
    const legacy = definition.agents.flatMap((a) =>
      (a.credentials ?? []).filter((c) => !isScopedRef(c.secret)).map((c) => c.secret),
    );
    const configs = await this.catalog.mcpConfigs(scope);
    const connections = definition.agents.flatMap((a) =>
      configs
        .filter((c) => serversOf(a).has(c.name) && connectionCarriesCredentials(c))
        .map((c) => c.name),
    );
    if (legacy.length === 0 && connections.length === 0) return;
    throw new HttpError(
      400,
      'production_credentials_in_draft',
      'a development run may not use operator secrets or credentialed MCP connections; they count as production credentials (allowDraftRuns: on with allowProductionSecretsInDraftRuns lifts this)',
      { legacyReferences: [...new Set(legacy)], connections: [...new Set(connections)] },
    );
  }
}
