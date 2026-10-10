import { and, eq } from 'drizzle-orm';
import { OaxError, resolveRoute, type Principal, type SecretResolver } from '@openagentix/core';
import {
  McpServerConfigSchema,
  authKindOf,
  canonicalResource,
  requestedScopes,
  scopesNeededByProfiles,
  type McpOauthAuth,
  type McpServerConfig,
  type McpTokenSource,
} from '@openagentix/mcp';
import {
  createOutboundDispatcher,
  legacyNetwork,
  type OutboundDispatcher,
} from '@openagentix/providers';
import { getNetworkSettings } from '../airgap.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { connections, mcpOauthTokens } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { ClientCredentials } from '../mcp-oauth/client-auth.js';
import { refreshSkewMs, type ConnectionRef } from '../mcp-oauth/credentials.js';
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  endpointHosts,
  pinOf,
  samePin,
  type AuthServerMetadata,
} from '../mcp-oauth/discovery.js';
import { assertTokenShape } from '../mcp-oauth/token-shape.js';
import { OauthFetch, hostOf, type OauthOrigin } from '../mcp-oauth/oauth-fetch.js';
import type { McpOauthStores } from '../mcp-oauth/index.js';
import { lockCredential, ownerKey, type TokenStatus } from '../mcp-oauth/token-store.js';
import { TokenRequestError, requestToken, revokeToken } from '../mcp-oauth/token-client.js';
import type { AuditService } from './audit.js';
import type { CatalogService, ConnectionRow } from './catalog.js';
import type { RunNodesService } from './run-nodes.js';
import type { ContextGuard } from '@openagentix/core';

type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;
type OauthConfig = HttpConfig & { auth: McpOauthAuth };

/** Authorizations per user and minute: each one makes the platform contact a server a tenant chose. */
const AUTHORIZE_LIMIT = 10;
const WINDOW_MS = 60_000;
/** Discovery results are trusted for at most an hour (ADR 0016 section 7.3). */
const DISCOVERY_TTL_MS = 60 * 60_000;
/** Renewals of one connection closer together than this are refused (a server that keeps saying 401). */
const MIN_REFRESH_GAP_MS = 5_000;
const SYSTEM_ACTOR = 'system:mcp-oauth';

/** What the console may know about the OAuth state of a connection: no value, no ciphertext. */
export interface OauthStatus {
  status: 'not_authorized' | TokenStatus;
  grant: string;
  issuer: string | null;
  pinnedIssuer: string | null;
  scopes: string[];
  expiresAt: string | null;
  authorizedAt: string | null;
  authorizedBy: string | null;
  lastError: string | null;
  /** Hosts the connection contacts besides the MCP server (purpose `identity`). */
  endpointHosts: string[];
  /** The granted scopes exceed what the profiles need (`mcp_scope_wider`). */
  scopesWider: boolean;
}

/** Revokes what a connection held once the change that made it necessary has been committed. */
export interface PendingRevocation {
  /**
   * `rows`: `delete` (default) removes the stored rows; `gone` means a transaction already
   * removed them (change, deletion); `replaced` means new tokens were stored in their place
   * (re-authorization): only the old values are forgotten by the redactors, not the owner's.
   */
  run(reason: string, actor?: string, rows?: 'delete' | 'gone' | 'replaced'): Promise<void>;
}

const splitScopes = (s: string | undefined) => (s ?? '').split(' ').filter(Boolean);

function oauthConfig(row: ConnectionRow): OauthConfig | null {
  if (row.kind !== 'mcp') return null;
  const parsed = McpServerConfigSchema.safeParse(row.config);
  if (!parsed.success || parsed.data.transport !== 'streamable-http') return null;
  return authKindOf(parsed.data) === 'oauth' ? (parsed.data as OauthConfig) : null;
}

/**
 * OAuth for HTTP MCP connections (ADR 0016 section 7), client-credentials flow: discovery,
 * authorization, renewal under a cross-replica lock, revocation and audit. Runs in the trusted
 * processes only (the api and the trusted worker): it is the one place that talks to authorization
 * servers and the only caller of the token store besides {@link McpCredentials}.
 */
export class McpOauthService {
  private outbound: OutboundDispatcher | undefined;
  private ownOutbound: OutboundDispatcher | undefined;
  private fetcher: OauthFetch | undefined;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly verified = new Map<string, number>();
  private readonly lastRefresh = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly runNodes: RunNodesService,
    private readonly stores: McpOauthStores,
  ) {
    stores.credentials.useRefresher({ refresh: (c) => this.refresh(c) });
    catalog.oauth = {
      prepareRevoke: (row) => this.prepareRevoke(row),
    };
  }

  /** The worker has its own network configuration for MCP; it passes that dispatcher here. */
  setOutbound(d: OutboundDispatcher): void {
    this.outbound = d;
    this.fetcher = undefined;
  }

  async close(): Promise<void> {
    await this.ownOutbound?.close().catch(() => undefined);
    this.ownOutbound = undefined;
    this.fetcher = undefined;
  }

  private dispatcher(): OutboundDispatcher {
    if (this.outbound) return this.outbound;
    if (this.ctx.mcpOutbound) return this.ctx.mcpOutbound;
    const settings = getNetworkSettings();
    return (this.ownOutbound ??= createOutboundDispatcher({
      ...(settings ? { network: settings.net } : {}),
    }));
  }

  private http(): OauthFetch {
    return (this.fetcher ??= new OauthFetch(() => this.dispatcher(), {
      ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
    }));
  }

  // ---------- token source for the transport ----------

  /**
   * The token source of one connection for a gateway: asks the credentials service before every
   * request (renewal included) and registers the value with the gateway's guard. A 401 marks the
   * stored token expired so that the next request renews it.
   */
  sourceFor(
    row: Pick<ConnectionRow, 'id' | 'tenantId' | 'credentialVersion'>,
    cfg: HttpConfig,
    guard: ContextGuard,
  ): McpTokenSource {
    const ref: ConnectionRef = { id: row.id, tenantId: row.tenantId };
    const scopes = requestedScopes(cfg);
    return {
      accessToken: () => this.stores.credentials.accessToken(ref, scopes, { guard }),
      rejected: (rejected) => {
        void this.stores.tokens
          .expireIfCurrent(row.tenantId, row.id, row.credentialVersion, rejected)
          .catch(() => undefined);
      },
    };
  }

  /** `ConnectDeps.tokens` for a set of connections by server name. */
  tokensFor(
    rows: ReadonlyMap<string, { row: ConnectionRow; cfg: HttpConfig }>,
    guard: ContextGuard,
  ): (server: string) => McpTokenSource | undefined {
    return (server) => {
      const e = rows.get(server);
      return e && authKindOf(e.cfg) === 'oauth' ? this.sourceFor(e.row, e.cfg, guard) : undefined;
    };
  }

  // ---------- helpers ----------

  private originOf(row: ConnectionRow): OauthOrigin {
    return row.scope === 'platform' ? 'platform' : 'tenant';
  }

  private async resolverOf(row: ConnectionRow): Promise<SecretResolver> {
    return row.scope === 'platform' ? this.ctx.secrets : this.runNodes.resolverFor(row.tenantId);
  }

  private limit(userId: string): void {
    const now = this.ctx.now().getTime();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= (this.ctx.mcpProbeLimit ?? AUTHORIZE_LIMIT))
      throw new HttpError(429, 'rate_limited', 'too many authorizations, try again in a minute');
    recent.push(now);
    this.hits.set(userId, recent);
    if (this.hits.size > 1000) this.hits.clear();
  }

  /** Reads the client secrets of the connection; the values go to the redactors at once. */
  private async clientOf(
    row: ConnectionRow,
    cfg: OauthConfig,
    resolver: SecretResolver,
  ): Promise<ClientCredentials> {
    const c = cfg.auth.client;
    const owner = `${row.id}:client`;
    // Only values with the shape of a credential become redaction targets (a weak secret such as
    // a short word would blank ordinary text); the run's guard still covers weak secrets.
    const reg = (v: string) => {
      try {
        assertTokenShape(v);
      } catch {
        return;
      }
      this.stores.registry.register(v, { owner, tenant: row.tenantId, ttlMs: 10 * 60_000 });
    };
    try {
      const clientId = await resolver.resolve(c.clientIdSecret);
      if (c.clientAuth === 'client_secret_basic') {
        const secret = await resolver.resolve(c.clientSecretSecret as string);
        reg(secret);
        return { clientId, method: 'client_secret_basic', secret };
      }
      const privateKeyPem = await resolver.resolve(c.keySecret as string);
      reg(privateKeyPem);
      return {
        clientId,
        method: 'private_key_jwt',
        privateKeyPem,
        ...(c.keyId ? { keyId: c.keyId } : {}),
      };
    } catch {
      // The reason can name a secret reference or quote a file path.
      throw new OaxError(
        'mcp_oauth_client_unavailable',
        'the OAuth client credentials of this connection cannot be read',
      );
    }
  }

  /** Tenant destination rules and the air-gapped allowlist for every endpoint a document named. */
  private assertEndpointsAllowed(row: ConnectionRow, urls: Iterable<string>): void {
    const net = getNetworkSettings()?.net ?? legacyNetwork(process.env);
    for (const url of urls) {
      const route = resolveRoute(url, 'identity', { origin: this.originOf(row) }, net);
      if (route.decision === 'deny')
        throw new OaxError('egress_denied', `${hostOf(url)} is not an allowed destination`, {
          code: route.code,
        });
    }
  }

  private checkAlgorithm(cfg: OauthConfig, as: AuthServerMetadata): void {
    if (as.grantTypes && !as.grantTypes.includes('client_credentials'))
      throw new OaxError(
        'mcp_oauth_unsupported',
        'the authorization server does not support client_credentials',
      );
    if (!as.tokenAuthMethods.includes(cfg.auth.client.clientAuth))
      throw new OaxError(
        'mcp_oauth_unsupported',
        `the authorization server does not support ${cfg.auth.client.clientAuth}`,
      );
  }

  private async denied(row: ConnectionRow, actor: string, e: unknown): Promise<void> {
    const code =
      e instanceof OaxError
        ? ({
            egress_denied: 'egress_denied',
            mcp_issuer_mismatch: 'issuer_mismatch',
            mcp_resource_mismatch: 'resource_mismatch',
            mcp_resource_metadata_origin: 'resource_metadata_origin',
            mcp_oauth_endpoints_changed: 'endpoints_changed',
          }[e.code] ?? null)
        : null;
    if (!code) return;
    await this.audit.append({
      actor,
      tenantId: row.tenantId,
      action: 'mcp.oauth.denied',
      target: row.id,
      payload: { connection: row.id, code },
    });
  }

  // ---------- authorization ----------

  async authorize(
    actor: Principal,
    id: string,
    body: { issuer?: string | undefined } = {},
  ): Promise<OauthStatus> {
    const row = await this.catalog.getOwnConnection(actor, id);
    const cfg = oauthConfig(row);
    if (!cfg)
      throw new HttpError(
        400,
        'mcp_oauth_not_configured',
        'the connection is not an HTTP MCP connection with auth.kind "oauth"',
      );
    this.limit(actor.userId);
    const origin = this.originOf(row);
    const by = actor.userId;
    let issuer: string;
    let as: AuthServerMetadata;
    let scopes: string[];
    try {
      const prm = await discoverProtectedResource(this.http(), cfg.url, origin);
      // The issuer pinned in the configuration, else the one pinned by an earlier authorization:
      // a new authorization may move to another server only when the administrator names it.
      const earlier = (await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion))
        ?.issuer;
      const pinned = cfg.auth.issuer ?? earlier;
      const wanted = body.issuer ?? pinned;
      if (cfg.auth.issuer && body.issuer && body.issuer !== cfg.auth.issuer)
        throw new OaxError('mcp_issuer_mismatch', 'the issuer differs from the one pinned');
      if (
        !body.issuer &&
        !cfg.auth.issuer &&
        earlier &&
        !prm.authorizationServers.includes(earlier)
      )
        throw new HttpError(
          409,
          'mcp_oauth_issuer_required',
          'the resource no longer names the authorization server of the earlier authorization: confirm the new one',
          { issuers: prm.authorizationServers },
        );
      if (wanted) {
        if (!prm.authorizationServers.includes(wanted))
          throw new OaxError('mcp_issuer_mismatch', 'the resource does not name that issuer');
        issuer = wanted;
      } else if (prm.authorizationServers.length === 1) issuer = prm.authorizationServers[0]!;
      else
        throw new HttpError(
          409,
          'mcp_oauth_issuer_required',
          'the resource names several authorization servers: choose one',
          { issuers: prm.authorizationServers },
        );
      as = await discoverAuthorizationServer(this.http(), issuer, origin);
      this.assertEndpointsAllowed(row, Object.values(pinOf(as)));
      this.checkAlgorithm(cfg, as);
      scopes = requestedScopes(cfg);
      if (scopes.length === 0) scopes = splitScopes(prm.challengeScope);
      if (scopes.length === 0) scopes = prm.scopesSupported;
    } catch (e) {
      await this.denied(row, `user:${by}`, e);
      throw e;
    }
    await this.audit.append({
      actor: `user:${by}`,
      tenantId: row.tenantId,
      action: 'mcp.oauth.discovered',
      target: id,
      payload: {
        connection: id,
        issuer,
        resource: canonicalResource(cfg.url),
        endpointHosts: endpointHosts(pinOf(as)),
      },
    });
    const resolver = await this.resolverOf(row);
    const client = await this.clientOf(row, cfg, resolver);
    const resource = canonicalResource(cfg.url);
    const issued = await requestToken(this.http(), {
      tokenEndpoint: as.tokenEndpoint,
      grant: 'client_credentials',
      client,
      scope: scopes,
      resource,
      origin,
      now: this.ctx.now(),
      algsSupported: as.signingAlgs,
      ids: [row.tenantId, row.id],
    }).catch(async (e: unknown) => {
      await this.audit.append({
        actor: `user:${by}`,
        tenantId: row.tenantId,
        action: 'mcp.oauth.refresh_failed',
        target: id,
        payload: {
          connection: id,
          error: e instanceof OaxError ? e.code : 'error',
          phase: 'authorize',
        },
      });
      throw e;
    });
    this.register(row, issued.accessToken, issued.refreshToken, issued.expiresIn);
    for (const v of issued.sensitive) this.registerIfShaped(row, v);
    // Tokens held for another issuer or other endpoints are revoked there once the new ones are in.
    const previous = await this.prepareRevoke(row);
    const expiresAt = issued.expiresIn
      ? new Date(this.ctx.now().getTime() + issued.expiresIn * 1000)
      : undefined;
    await this.stores.tokens.put({
      tenantId: row.tenantId,
      connectionId: row.id,
      credentialVersion: row.credentialVersion,
      issuer,
      resource,
      clientRef: cfg.auth.client.clientIdSecret,
      scopes: issued.scope ?? scopes,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt,
      authorizedBy: by,
      grantType: 'client_credentials',
      endpoints: pinOf(as),
    });
    this.verified.set(`${row.id}:${row.credentialVersion}`, this.ctx.now().getTime());
    await this.audit.append({
      actor: `user:${by}`,
      tenantId: row.tenantId,
      action: 'mcp.oauth.authorized',
      target: id,
      payload: {
        connection: id,
        issuer,
        grant: 'client_credentials',
        scopes: issued.scope ?? scopes,
        by,
      },
    });
    // The previous tokens (if any) were overwritten; tell their issuer.
    await previous?.run('reauthorized', `user:${by}`, 'replaced');
    return this.status(actor, id);
  }

  private registerIfShaped(row: ConnectionRow, v: string): void {
    try {
      assertTokenShape(v);
    } catch {
      return;
    }
    this.stores.registry.register(v, { tenant: row.tenantId, ttlMs: 10 * 60_000 });
  }

  private register(row: ConnectionRow, access: string, refresh?: string, ttl?: number): void {
    const owner = ownerKey(row.id, row.credentialVersion);
    for (const v of [access, refresh])
      if (v)
        this.stores.registry.register(v, {
          owner,
          tenant: row.tenantId,
          ttlMs: ttl ? ttl * 1000 : 60 * 60_000,
        });
  }

  // ---------- status ----------

  async status(actor: Principal, id: string): Promise<OauthStatus> {
    const row = await this.catalog.getConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    if (row.tenantId !== actor.tenantId)
      throw new HttpError(
        403,
        'forbidden',
        'platform connections are managed by the platform operator',
      );
    const parsed = McpServerConfigSchema.safeParse(row.config);
    const cfg = parsed.success && parsed.data.transport === 'streamable-http' ? parsed.data : null;
    const meta = await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion);
    const needed = cfg ? scopesNeededByProfiles(cfg) : [];
    const granted = meta?.scopes ?? [];
    return {
      status: meta?.status ?? 'not_authorized',
      grant:
        meta?.grantType ?? (cfg?.auth?.kind === 'oauth' ? cfg.auth.grant : 'client_credentials'),
      issuer: meta?.issuer ?? null,
      pinnedIssuer: cfg?.auth?.kind === 'oauth' ? (cfg.auth.issuer ?? null) : null,
      scopes: granted,
      expiresAt: meta?.expiresAt?.toISOString() ?? null,
      authorizedAt: meta?.authorizedAt.toISOString() ?? null,
      authorizedBy: meta?.authorizedBy ?? null,
      lastError: meta?.lastError ?? null,
      endpointHosts: meta ? endpointHosts(meta.endpoints) : [],
      scopesWider: needed.length > 0 && granted.some((s) => !needed.includes(s)),
    };
  }

  // ---------- renewal ----------

  /** Single flight per connection in this process; the advisory lock extends it across replicas. */
  refresh(ref: ConnectionRef): Promise<void> {
    const key = `${ref.tenantId}:${ref.id}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.refreshOnce(ref).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async rowOf(ref: ConnectionRef): Promise<ConnectionRow | undefined> {
    const [row] = await this.ctx.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, ref.id), eq(connections.tenantId, ref.tenantId)));
    return row;
  }

  private async refreshOnce(ref: ConnectionRef): Promise<void> {
    const row = await this.rowOf(ref);
    const cfg = row && oauthConfig(row);
    if (!row || !cfg)
      throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
    const meta = await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion);
    if (!meta || (meta.status !== 'active' && meta.status !== 'refresh_failed'))
      throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
    const gapKey = `${row.id}:${row.credentialVersion}`;
    const last = this.lastRefresh.get(gapKey);
    const nowMs = this.ctx.now().getTime();
    if (last !== undefined && nowMs - last < MIN_REFRESH_GAP_MS) {
      this.ctx.metrics.oauthRefresh('skipped');
      throw new OaxError('mcp_auth_refresh_failed', 'the access token was renewed a moment ago');
    }
    this.lastRefresh.set(gapKey, nowMs);
    if (this.lastRefresh.size > 5000) this.lastRefresh.clear();
    const origin = this.originOf(row);
    let as: AuthServerMetadata | undefined;
    try {
      as = await this.verifyPin(row, cfg, meta.issuer, meta.endpoints, origin);
      const resolver = await this.resolverOf(row);
      const client = await this.clientOf(row, cfg, resolver);
      await this.renewLocked(row, cfg, as, client, origin);
      this.ctx.metrics.oauthRefresh('ok');
      await this.audit.append({
        actor: SYSTEM_ACTOR,
        tenantId: row.tenantId,
        action: 'mcp.oauth.refreshed',
        target: row.id,
        payload: { connection: row.id, outcome: 'ok' },
      });
    } catch (e) {
      const permanent = await this.failRefresh(row, e);
      // `mcp_auth_required`: the credentials are no good until an administrator acts. The other
      // code is a failure that may pass; a token that has not expired yet is still used meanwhile.
      throw e instanceof OaxError && e.code === 'mcp_auth_required'
        ? e
        : permanent
          ? new OaxError('mcp_auth_required', 'the connection needs to be authorized again')
          : new OaxError('mcp_auth_refresh_failed', 'the access token could not be renewed');
    }
  }

  /**
   * The pinned issuer and endpoints must still be what the resource and the authorization server
   * publish (ADR 0016 sections 7.2, 7.3); otherwise no request goes out and the connection needs
   * a new authorization. Cached for an hour per connection and credential version.
   */
  private async verifyPin(
    row: ConnectionRow,
    cfg: OauthConfig,
    issuer: string,
    pinned: Record<string, string>,
    origin: OauthOrigin,
  ): Promise<AuthServerMetadata> {
    const key = `${row.id}:${row.credentialVersion}`;
    const at = this.verified.get(key);
    const fresh = at !== undefined && this.ctx.now().getTime() - at < DISCOVERY_TTL_MS;
    if (fresh) return this.pinnedMetadata(issuer, pinned);
    const prm = await discoverProtectedResource(this.http(), cfg.url, origin);
    if (
      !prm.authorizationServers.includes(issuer) ||
      (cfg.auth.issuer && cfg.auth.issuer !== issuer)
    )
      throw new OaxError('mcp_issuer_mismatch', 'the resource no longer names the pinned issuer');
    const as = await discoverAuthorizationServer(this.http(), issuer, origin);
    this.assertEndpointsAllowed(row, Object.values(pinOf(as)));
    if (!samePin(pinOf(as), pinned))
      throw new OaxError(
        'mcp_oauth_endpoints_changed',
        'the authorization server endpoints changed since the authorization',
      );
    this.checkAlgorithm(cfg, as);
    this.verified.set(key, this.ctx.now().getTime());
    return as;
  }

  private async pinnedMetadata(
    issuer: string,
    pin: Record<string, string>,
  ): Promise<AuthServerMetadata> {
    // Within the discovery window the pin itself is the truth; algorithms come from a fresh
    // document only when it is fetched again.
    return {
      issuer,
      tokenEndpoint: pin.tokenEndpoint as string,
      ...(pin.revocationEndpoint ? { revocationEndpoint: pin.revocationEndpoint } : {}),
      tokenAuthMethods: ['client_secret_basic', 'private_key_jwt'],
      issParameterSupported: false,
    };
  }

  /** Reads, renews and writes under a transaction-scoped advisory lock (one renewal at a time). */
  private async renewLocked(
    row: ConnectionRow,
    cfg: OauthConfig,
    as: AuthServerMetadata,
    client: ClientCredentials,
    origin: OauthOrigin,
  ): Promise<void> {
    await this.ctx.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockCredential(tx, row.id, row.credentialVersion);
      const stored = await this.stores.tokens.open(row.tenantId, row.id, row.credentialVersion, tx);
      if (!stored) throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
      const nowMs = this.ctx.now().getTime();
      const exp = stored.meta.expiresAt?.getTime();
      // Another replica renewed while this one waited for the lock: nothing left to do.
      if (
        stored.meta.status === 'active' &&
        exp !== undefined &&
        exp - nowMs > refreshSkewMs(stored.meta.updatedAt, new Date(exp)) &&
        stored.accessToken
      )
        return;
      const resource = canonicalResource(cfg.url);
      // A client-credentials grant has no refresh token to rotate (RFC 6749 section 4.4.3): it is
      // always renewed with a new grant, so a lost rotated token can never lock the connection out.
      const useRefresh =
        stored.meta.grantType === 'authorization_code' && stored.refreshToken !== null;
      const issued = await requestToken(this.http(), {
        tokenEndpoint: as.tokenEndpoint,
        grant: useRefresh ? 'refresh_token' : 'client_credentials',
        client,
        scope: useRefresh ? [] : stored.meta.scopes,
        resource,
        refreshToken: stored.refreshToken ?? undefined,
        origin,
        now: this.ctx.now(),
        algsSupported: as.signingAlgs,
        ids: [row.tenantId, row.id],
      });
      this.register(row, issued.accessToken, issued.refreshToken, issued.expiresIn);
      for (const v of issued.sensitive) this.registerIfShaped(row, v);
      // The rotated pair (or the new access token with the old refresh token) is one row update in
      // this transaction: a failure before the commit leaves the previous pair untouched.
      await this.stores.tokens.write(
        tx,
        {
          tenantId: row.tenantId,
          connectionId: row.id,
          credentialVersion: row.credentialVersion,
          issuer: stored.meta.issuer,
          resource,
          clientRef: cfg.auth.client.clientIdSecret,
          scopes: issued.scope ?? stored.meta.scopes,
          accessToken: issued.accessToken,
          refreshToken:
            issued.refreshToken ?? (useRefresh ? (stored.refreshToken ?? undefined) : undefined),
          expiresAt: issued.expiresIn ? new Date(nowMs + issued.expiresIn * 1000) : undefined,
          authorizedBy: stored.meta.authorizedBy ?? undefined,
          grantType: stored.meta.grantType as 'client_credentials' | 'authorization_code',
          endpoints: stored.meta.endpoints,
        },
        { updatedAt: stored.meta.updatedAt },
      );
    });
  }

  /** Records the failure; true when the credentials are rejected for good. */
  private async failRefresh(row: ConnectionRow, e: unknown): Promise<boolean> {
    let status: TokenStatus | null = null;
    let outcome = 'failed';
    let code = e instanceof OaxError ? e.code : 'error';
    if (e instanceof TokenRequestError) {
      code = e.oauth;
      if (e.permanent) {
        status = 'reauthorization_required';
        outcome = e.oauth === 'invalid_grant' ? 'invalid_grant' : 'reauthorization_required';
      }
    } else if (
      e instanceof OaxError &&
      ['mcp_issuer_mismatch', 'mcp_oauth_endpoints_changed', 'mcp_resource_mismatch'].includes(
        e.code,
      )
    ) {
      status = 'reauthorization_required';
      outcome = 'reauthorization_required';
      await this.denied(row, SYSTEM_ACTOR, e);
    }
    if (status === null) {
      // Transient: the stored token keeps working until it expires; an expired one is marked.
      const meta = await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion);
      const expired = !meta?.expiresAt || meta.expiresAt.getTime() <= this.ctx.now().getTime();
      status = expired ? 'refresh_failed' : 'active';
    }
    this.ctx.metrics.oauthRefresh(outcome);
    await this.stores.tokens
      .recordFailure(row.tenantId, row.id, row.credentialVersion, status, code.slice(0, 64))
      .catch(() => undefined);
    await this.audit.append({
      actor: SYSTEM_ACTOR,
      tenantId: row.tenantId,
      action: 'mcp.oauth.refresh_failed',
      target: row.id,
      payload: { connection: row.id, error: code.slice(0, 64), status },
    });
    return status === 'reauthorization_required';
  }

  // ---------- revocation ----------

  /**
   * Collects what a connection currently holds so it can be revoked after the change that makes
   * it necessary has been committed (the rows may be gone by then). `null` when nothing is stored.
   */
  async prepareRevoke(
    row: Pick<ConnectionRow, 'id' | 'tenantId' | 'scope' | 'config' | 'kind'>,
  ): Promise<PendingRevocation | null> {
    if (row.kind !== 'mcp') return null;
    const versions = await this.stores.tokens.versions(row.tenantId, row.id);
    if (versions.length === 0) return null;
    const held: { token: string; hint: 'access_token' | 'refresh_token'; endpoint?: string }[] = [];
    for (const v of versions) {
      let stored;
      try {
        stored = await this.stores.tokens.open(row.tenantId, row.id, v);
      } catch {
        continue;
      }
      if (!stored) continue;
      const endpoint = stored.meta.endpoints.revocationEndpoint;
      held.push({
        token: stored.accessToken,
        hint: 'access_token',
        ...(endpoint ? { endpoint } : {}),
      });
      if (stored.refreshToken)
        held.push({
          token: stored.refreshToken,
          hint: 'refresh_token',
          ...(endpoint ? { endpoint } : {}),
        });
    }
    const config = row.config;
    const full = row as ConnectionRow;
    return {
      run: async (reason, actor = SYSTEM_ACTOR, rows = 'delete') => {
        let remote: 'ok' | 'failed' | 'skipped' = 'skipped';
        const cfg = (() => {
          const p = McpServerConfigSchema.safeParse(config);
          return p.success &&
            p.data.transport === 'streamable-http' &&
            authKindOf(p.data) === 'oauth'
            ? (p.data as OauthConfig)
            : null;
        })();
        const targets = held.filter((h) => h.endpoint);
        if (cfg && targets.length > 0) {
          try {
            const client = await this.clientOf(full, cfg, await this.resolverOf(full));
            remote = 'ok';
            for (const t of targets) {
              const r = await revokeToken(this.http(), {
                endpoint: t.endpoint as string,
                token: t.token,
                hint: t.hint,
                client,
                origin: this.originOf(full),
                now: this.ctx.now(),
              });
              if (r !== 'ok') remote = 'failed';
            }
          } catch {
            remote = 'failed';
          }
        }
        if (rows === 'delete')
          await this.stores.tokens.delete(row.tenantId, row.id).catch(() => undefined);
        // After a re-authorization the new tokens are registered under the same owner.
        if (rows !== 'replaced')
          for (const v of versions) this.stores.registry.forgetOwner(ownerKey(row.id, v));
        await this.audit.append({
          actor,
          tenantId: row.tenantId,
          action: 'mcp.oauth.revoked',
          target: row.id,
          payload: { connection: row.id, reason, remote },
        });
      },
    };
  }

  async disconnect(actor: Principal, id: string): Promise<OauthStatus> {
    const row = await this.catalog.getOwnConnection(actor, id);
    const pending = await this.prepareRevoke(row);
    await pending?.run('disconnect', `user:${actor.userId}`);
    return this.status(actor, id);
  }

  /** Stored endpoints of every connection (air-gapped start-up check). */
  async pinnedEndpointsOf(): Promise<
    { connectionId: string; endpoints: Record<string, string> }[]
  > {
    const rows = await this.ctx.db
      .select({ c: mcpOauthTokens.connectionId, e: mcpOauthTokens.endpoints })
      .from(mcpOauthTokens);
    return rows.map((r) => ({ connectionId: r.c, endpoints: r.e }));
  }
}
