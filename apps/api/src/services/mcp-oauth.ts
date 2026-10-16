import { and, eq } from 'drizzle-orm';
import {
  OaxError,
  hasPermission,
  resolveRoute,
  type Principal,
  type SecretResolver,
} from '@openagentix/core';
import {
  McpServerConfigSchema,
  authKindOf,
  canonicalResource,
  clientAuthOf,
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
import { isLocalHost } from '../config.js';
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
  verifyIssuerParameter,
  type AuthServerMetadata,
} from '../mcp-oauth/discovery.js';
import { RenewalLimiter } from '../mcp-oauth/renewal-limiter.js';
import { assertTokenShape } from '../mcp-oauth/token-shape.js';
import {
  challengeOf,
  NONCE_HASH_SHAPE,
  NONCE_SHAPE,
  newSecretToken,
  nonceHash,
  sameString,
  STATE_SHAPE,
} from '../mcp-oauth/pkce.js';
import { callbackUrl, cimdUrl, registerClient } from '../mcp-oauth/registration.js';
import { OauthFetch, hostOf, type OauthOrigin } from '../mcp-oauth/oauth-fetch.js';
import type { McpOauthStores } from '../mcp-oauth/index.js';
import {
  lockCredential,
  ownerKey,
  type TokenStatus,
  type TokenWrite,
} from '../mcp-oauth/token-store.js';
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
/** After a renewal found no free slot, the same connection is not tried again for this long. */
const BUSY_BACKOFF_MS = 1_000;
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
  /** `preregistered`, `cimd` or `dcr` (authorization_code); null for client_credentials. */
  registration: 'preregistered' | 'cimd' | 'dcr' | null;
  /** The exact redirect URI of the authorization-code flow (what a pre-registered client lists). */
  redirectUri: string | null;
  /** Scopes the profiles need that the grant lacks (authorization_code): a new consent is due. */
  scopesMissing: string[];
  /** Scopes a server asked for with `insufficient_scope` (step-up). */
  requiredScopes: string[];
  /** A consent is due: the status says so, or the grant lacks scopes the profiles need. */
  reauthorizationNeeded: boolean;
  /** The consent request of the caller that has not been answered yet. */
  pendingExpiresAt: string | null;
}

/** What `authorize` answers: the status, plus the URL to open for an authorization-code consent. */
export interface OauthAuthorizeResult extends OauthStatus {
  authorizationUrl: string | null;
}

/** The closed outcomes of the callback; the route turns one into a redirect or a small page. */
export const CALLBACK_RESULTS = [
  'ok',
  'denied',
  'state_invalid',
  'state_expired',
  'iss_mismatch',
  'iss_missing',
  'code_invalid',
  'token_refused',
  'forbidden',
  'conflict',
  'error',
] as const;
export type CallbackResult = (typeof CALLBACK_RESULTS)[number];
export interface CallbackOutcome {
  result: CallbackResult;
  /** Known only when the state was valid; it comes from the stored request, never from the URL. */
  connectionId?: string;
}

/** What the console reports after the redirect (read from the URL fragment); only plain strings count. */
export interface CompleteInput {
  /** The browser's nonce of this consent; its SHA-256 was sent when the consent started. */
  nonce?: string | undefined;
  state?: string | undefined;
  code?: string | undefined;
  iss?: string | undefined;
  error?: string | undefined;
}

const CALLBACK_ERRORS: ReadonlySet<string> = new Set([
  'access_denied',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_request',
  'interaction_required',
  'login_required',
  'consent_required',
]);

/** An authorization code is opaque but bounded printable ASCII (RFC 6749 appendix A.11). */
const CODE_SHAPE = /^[\x21-\x7e]{1,2048}$/;

/** Revokes what a connection held once the change that made it necessary has been committed. */
export interface PendingRevocation {
  /**
   * `rows`: `delete` (default) removes the stored rows; `gone` means a transaction already
   * removed them (change, deletion); `replaced` means new tokens were stored in their place
   * (re-authorization): only the old values are forgotten by the redactors, not the owner's.
   */
  run(reason: string, actor?: string, rows?: 'delete' | 'gone' | 'replaced'): Promise<void>;
}

/** A renewed token pair that the server issued but the database has not (yet) confirmed. */
interface Rotation {
  write: TokenWrite;
  /** `updated_at` of the row it replaces: the pair is written only over exactly that row. */
  replace: Date;
  /** The refresh token the stored row held when the server rotated it (identifies the row later). */
  previousRefresh: string | null;
}

/** Errors that retrying the commit cannot cure: the stored row changed or the connection did. */
const DETERMINISTIC = new Set([
  'mcp_auth_required',
  'mcp_token_changed',
  'not_found',
  'conflict',
  'mcp_resource_mismatch',
]);

const busyError = () =>
  new OaxError('mcp_auth_refresh_failed', 'the access token could not be renewed just now');

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
  /**
   * Connections whose pinned issuer and endpoints were verified, with the time and the signing
   * algorithms the authorization server published then (needed to pick the JWS algorithm of a
   * private_key_jwt assertion while the pin is not re-fetched).
   */
  private readonly verified = new Map<
    string,
    { at: number; algs: readonly string[] | undefined }
  >();
  private readonly lastRefresh = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  /** Rotated token pairs that could not be committed yet (see {@link persistRotation}). */
  private readonly unpersisted = new Map<string, Rotation>();
  /** Renewals running at once, per process and tenant (see {@link RenewalLimiter}). */
  private readonly limiter: RenewalLimiter;
  /** Connections whose renewal found the limiter full, with the time before which it is not retried. */
  private readonly busyUntil = new Map<string, number>();
  /** Pauses between attempts to commit a rotated token pair; tests shorten them. */
  rotationRetryMs: readonly number[] = [250, 1000, 3000];
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly runNodes: RunNodesService,
    private readonly stores: McpOauthStores,
  ) {
    const { renewals } = ctx.config.mcp.oauth;
    this.limiter = new RenewalLimiter(renewals.max, renewals.perTenant);
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
      insufficientScope: (token, needed) => {
        void this.stepUp(row, token, needed).catch(() => undefined);
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

  /** Redaction target for a client secret: only values with the shape of a credential qualify. */
  private registerSecret(row: ConnectionRow, owner: string, v: string): void {
    // A weak secret such as a short word would blank ordinary text; the run's guard still covers it.
    try {
      assertTokenShape(v);
    } catch {
      return;
    }
    this.stores.registry.register(v, { owner, tenant: row.tenantId, ttlMs: 10 * 60_000 });
  }

  /**
   * The client of the connection at one authorization server. `preregistered`: the secret
   * references of the configuration are read; `cimd`: the platform's metadata document URL is the
   * id; `dcr`: the registration stored for this tenant and issuer. The values go to the redactors
   * at once.
   */
  async clientOf(
    row: ConnectionRow,
    cfg: OauthConfig,
    resolver: SecretResolver,
    issuer: string,
  ): Promise<ClientCredentials> {
    const c = cfg.auth.client;
    const owner = `${row.id}:client`;
    if (c.registration === 'cimd') {
      if (!this.ctx.config.mcp.oauth.cimd)
        throw new OaxError(
          'mcp_oauth_cimd_disabled',
          'client ID metadata documents are not enabled',
        );
      return { clientId: cimdUrl(this.ctx.config.publicUrl), method: 'none' };
    }
    if (c.registration === 'dcr') {
      const reg = await this.stores.clients.get(row.tenantId, issuer);
      if (!reg)
        throw new OaxError(
          'mcp_oauth_client_unavailable',
          'no client is registered for this authorization server',
        );
      if (reg.clientSecret) {
        this.registerSecret(row, owner, reg.clientSecret);
        return { clientId: reg.clientId, method: 'client_secret_basic', secret: reg.clientSecret };
      }
      return { clientId: reg.clientId, method: 'none' };
    }
    try {
      const clientId = await resolver.resolve(c.clientIdSecret as string);
      if (c.clientAuth === 'none') return { clientId, method: 'none' };
      if (c.clientAuth === 'client_secret_basic') {
        const secret = await resolver.resolve(c.clientSecretSecret as string);
        this.registerSecret(row, owner, secret);
        return { clientId, method: 'client_secret_basic', secret };
      }
      const privateKeyPem = await resolver.resolve(c.keySecret as string);
      this.registerSecret(row, owner, privateKeyPem);
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

  private checkAlgorithm(cfg: OauthConfig, as: AuthServerMetadata, method?: string): void {
    const grant = cfg.auth.grant;
    if (as.grantTypes && !as.grantTypes.includes(grant))
      throw new OaxError(
        'mcp_oauth_unsupported',
        `the authorization server does not support ${grant}`,
      );
    // DCR decides the method at registration time; the others are configured.
    const wanted =
      method ??
      (cfg.auth.client.registration === 'dcr' ? undefined : clientAuthOf(cfg.auth.client));
    if (wanted && wanted !== 'none' && !as.tokenAuthMethods.includes(wanted))
      throw new OaxError(
        'mcp_oauth_unsupported',
        `the authorization server does not support ${wanted}`,
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
            mcp_pkce_unsupported: 'pkce_unsupported',
            mcp_oauth_iss_unverifiable: 'iss_unverifiable',
            mcp_oauth_cimd_disabled: 'registration_disabled',
            mcp_oauth_dcr_disabled: 'registration_disabled',
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

  /**
   * Discovery shared by both grants: the issuer (pinned in the configuration, pinned by an earlier
   * authorization, or the only one the resource names), its metadata with every endpoint checked
   * against the destination rules, and the scopes the resource suggests.
   */
  private async discover(
    row: ConnectionRow,
    cfg: OauthConfig,
    body: { issuer?: string | undefined },
    by: string,
  ): Promise<{ issuer: string; as: AuthServerMetadata; scopes: string[] }> {
    const origin = this.originOf(row);
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
      let issuer: string;
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
      const as = await discoverAuthorizationServer(this.http(), issuer, origin);
      this.assertEndpointsAllowed(row, Object.values(pinOf(as)));
      let scopes = requestedScopes(cfg);
      if (scopes.length === 0) scopes = splitScopes(prm.challengeScope);
      if (scopes.length === 0) scopes = prm.scopesSupported;
      await this.audit.append({
        actor: `user:${by}`,
        tenantId: row.tenantId,
        action: 'mcp.oauth.discovered',
        target: row.id,
        payload: {
          connection: row.id,
          issuer,
          resource: canonicalResource(cfg.url),
          endpointHosts: endpointHosts(pinOf(as)),
        },
      });
      return { issuer, as, scopes };
    } catch (e) {
      await this.denied(row, `user:${by}`, e);
      throw e;
    }
  }

  async authorize(
    actor: Principal,
    id: string,
    body: { issuer?: string | undefined; nonceHash?: string | undefined } = {},
  ): Promise<OauthAuthorizeResult> {
    const row = await this.catalog.getOwnConnection(actor, id);
    const cfg = oauthConfig(row);
    if (!cfg)
      throw new HttpError(
        400,
        'mcp_oauth_not_configured',
        'the connection is not an HTTP MCP connection with auth.kind "oauth"',
      );
    this.limit(actor.userId);
    if (cfg.auth.grant === 'authorization_code')
      return this.startAuthorization(actor, row, cfg, body);
    const origin = this.originOf(row);
    const by = actor.userId;
    const { issuer, as, scopes } = await this.discover(row, cfg, body, by).then((d) => {
      this.checkAlgorithm(cfg, d.as);
      return d;
    });
    const resolver = await this.resolverOf(row);
    const client = await this.clientOf(row, cfg, resolver, issuer);
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
      clientRef: cfg.auth.client.clientIdSecret as string,
      scopes: issued.scope ?? scopes,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt,
      authorizedBy: by,
      grantType: 'client_credentials',
      endpoints: pinOf(as),
    });
    this.verified.set(`${row.id}:${row.credentialVersion}`, {
      at: this.ctx.now().getTime(),
      algs: as.signingAlgs,
    });
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
    return { ...(await this.status(actor, id)), authorizationUrl: null };
  }

  // ---------- authorization code (ADR 0016 section 7.2) ----------

  /** The exact redirect URI; a plain-http public URL is accepted only for a loopback host (development). */
  redirectUriOf(): string {
    const base = this.ctx.config.publicUrl;
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      throw new HttpError(400, 'mcp_oauth_redirect_invalid', 'OAX_PUBLIC_URL is not a URL');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname)))
      throw new HttpError(
        400,
        'mcp_oauth_redirect_insecure',
        'the redirect URI needs an https OAX_PUBLIC_URL (http is accepted for localhost only)',
      );
    if (u.username || u.password || u.search || u.hash || u.pathname.replace(/\/$/, '') !== '')
      throw new HttpError(
        400,
        'mcp_oauth_redirect_invalid',
        'OAX_PUBLIC_URL must be an origin without credentials, path, query or fragment',
      );
    return callbackUrl(base);
  }

  /** The client of a new consent: pre-registered, the metadata document, or a dynamic registration. */
  private async clientForConsent(
    row: ConnectionRow,
    cfg: OauthConfig,
    as: AuthServerMetadata,
    issuer: string,
    redirectUri: string,
    by: string,
  ): Promise<{ client: ClientCredentials; clientRef: string }> {
    const c = cfg.auth.client;
    const origin = this.originOf(row);
    if (c.registration === 'cimd') {
      if (!this.ctx.config.mcp.oauth.cimd || this.ctx.config.airgap.enabled)
        throw new OaxError(
          'mcp_oauth_cimd_disabled',
          'client ID metadata documents are not enabled',
        );
      if (as.cimdSupported !== true)
        throw new OaxError(
          'mcp_oauth_unsupported',
          'the authorization server does not accept client ID metadata documents',
        );
      const client = await this.clientOf(row, cfg, await this.resolverOf(row), issuer);
      return { client, clientRef: client.clientId };
    }
    if (c.registration === 'dcr') {
      if (!this.ctx.config.mcp.oauth.dcr || this.ctx.config.airgap.enabled)
        throw new OaxError('mcp_oauth_dcr_disabled', 'dynamic client registration is not enabled');
      let reg = await this.stores.clients.get(row.tenantId, issuer);
      // The registration lists one redirect URI: a changed public URL needs a new client.
      if (reg && reg.redirectUri !== redirectUri) {
        await this.stores.clients.delete(row.tenantId, reg.id);
        reg = null;
      }
      if (!reg) {
        if (!as.registrationEndpoint)
          throw new OaxError(
            'mcp_oauth_unsupported',
            'the authorization server offers no dynamic client registration',
          );
        const made = await registerClient(
          this.http(),
          as.registrationEndpoint,
          redirectUri,
          origin,
          as.tokenAuthMethods,
        );
        const id = await this.stores.clients.put({
          tenantId: row.tenantId,
          issuer,
          clientId: made.clientId,
          clientSecret: made.clientSecret,
          redirectUri,
          registration: 'dcr',
          createdBy: by,
        });
        // Another request registered first: its client wins, ours stays unused at the server.
        if (id !== null)
          await this.audit.append({
            actor: `user:${by}`,
            tenantId: row.tenantId,
            action: 'mcp.oauth.client_registered',
            target: row.id,
            payload: { tenant: row.tenantId, issuer, method: 'dcr' },
          });
        reg = await this.stores.clients.get(row.tenantId, issuer);
        if (!reg) throw new OaxError('mcp_oauth_client_unavailable', 'the registration was lost');
      }
      const client = await this.clientOf(row, cfg, await this.resolverOf(row), issuer);
      return { client, clientRef: reg.id };
    }
    const client = await this.clientOf(row, cfg, await this.resolverOf(row), issuer);
    return { client, clientRef: c.clientIdSecret as string };
  }

  private async startAuthorization(
    actor: Principal,
    row: ConnectionRow,
    cfg: OauthConfig,
    body: { issuer?: string | undefined; nonceHash?: string | undefined },
  ): Promise<OauthAuthorizeResult> {
    const by = actor.userId;
    // The callback hands the browser back to the console, which completes the consent with its
    // session and its nonce: both are needed.
    if (!this.ctx.config.uiUrl)
      throw new HttpError(
        400,
        'mcp_oauth_ui_url_required',
        'the authorization-code flow needs OAX_UI_URL (the callback returns the browser to the console)',
      );
    if (typeof body.nonceHash !== 'string' || !NONCE_HASH_SHAPE.test(body.nonceHash))
      throw new HttpError(400, 'validation_failed', 'nonceHash (SHA-256, hex) is required');
    // A human's consent cannot be shared with the tenants that use a central instance.
    if (row.scope === 'platform')
      throw new HttpError(
        400,
        'central_user_delegation',
        "authorization_code is refused on central instances: a person's consent cannot be shared with other tenants",
      );
    const redirectUri = this.redirectUriOf();
    const { issuer, as, scopes: suggested } = await this.discover(row, cfg, body, by);
    try {
      if (!as.authorizationEndpoint)
        throw new OaxError(
          'mcp_oauth_unsupported',
          'the authorization server publishes no authorization endpoint',
        );
      // OAuth 2.1 and the MCP specification: PKCE with S256 or no authorization. A server that does
      // not advertise it is refused, because the client cannot tell whether it verifies the challenge.
      if (!as.codeChallengeMethods?.includes('S256'))
        throw new OaxError(
          'mcp_pkce_unsupported',
          'the authorization server does not advertise PKCE with S256',
        );
      this.checkAlgorithm(cfg, as);
    } catch (e) {
      await this.denied(row, `user:${by}`, e);
      throw e;
    }
    // The first consent without a pin: the administrator sees the server and the scopes the MCP
    // server suggested and names the issuer to confirm, before the browser is sent anywhere.
    const known = await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion);
    const pinnedAlready =
      cfg.auth.issuer !== undefined ||
      (known?.grantType === 'authorization_code' && known.issuer === issuer);
    if (!pinnedAlready && body.issuer !== issuer)
      throw new HttpError(
        409,
        'mcp_oauth_issuer_required',
        'confirm the authorization server and the scopes before the first consent',
        { issuers: [issuer], scopes: suggested },
      );
    const { client, clientRef } = await this.clientForConsent(
      row,
      cfg,
      as,
      issuer,
      redirectUri,
      by,
    );
    // RFC 9207 is the defence against a forwarded browser (mix-up). A public client cannot be told
    // apart from the same client at another server, so without `iss` and without a pinned issuer
    // the response could not be attributed.
    if (client.method === 'none' && !as.issParameterSupported && !cfg.auth.issuer) {
      const e = new OaxError(
        'mcp_oauth_iss_unverifiable',
        'a public client needs an authorization server that sends the iss parameter (RFC 9207) or a pinned auth.issuer',
      );
      await this.denied(row, `user:${by}`, e);
      throw e;
    }
    // Step-up: the new consent covers what is granted, what a server asked for and what the
    // profiles need, so that no scope is lost when the administrator consents again.
    const meta = await this.stores.tokens.meta(row.tenantId, row.id, row.credentialVersion);
    const sameIssuer = meta && meta.issuer === issuer && meta.grantType === 'authorization_code';
    const wanted = new Set([
      ...suggested,
      ...(sameIssuer
        ? [
            ...meta.scopes,
            // what a server asked for, limited to what this authorization server offers
            ...meta.requiredScopes.filter(
              (x) => !as.scopesSupported || as.scopesSupported.includes(x),
            ),
          ]
        : []),
    ]);
    // offline_access only when the server advertises it (refresh tokens for unattended runs).
    if (as.scopesSupported?.includes('offline_access')) wanted.add('offline_access');
    const scopes = [...wanted].sort();
    const state = newSecretToken();
    const verifier = newSecretToken();
    const resource = canonicalResource(cfg.url);
    await this.stores.pending.create({
      state,
      verifier,
      tenantId: row.tenantId,
      connectionId: row.id,
      credentialVersion: row.credentialVersion,
      userId: by,
      nonceHash: body.nonceHash,
      issuer,
      resource,
      redirectUri,
      clientRef,
      registration: cfg.auth.client.registration,
      scopes,
      endpoints: pinOf(as),
      signingAlgs: as.signingAlgs,
      issAdvertised: as.issParameterSupported,
    });
    const url = new URL(as.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      resource,
    }))
      url.searchParams.set(k, v);
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    this.ctx.metrics.oauthAuthorize('started');
    await this.audit.append({
      actor: `user:${by}`,
      tenantId: row.tenantId,
      action: 'mcp.oauth.authorization_requested',
      target: row.id,
      payload: { connection: row.id, issuer, grant: 'authorization_code', scopes, by },
    });
    return {
      ...(await this.status(actor, row.id)),
      authorizationUrl: url.toString(),
    };
  }

  /**
   * The callback of the authorization server (browser redirect, no session). Authenticity rests on
   * the single-use state: it is bound to the person, connection and tenant that started the request
   * and is consumed before anything else happens. Every outcome is one of {@link CALLBACK_RESULTS};
   * nothing from the query is echoed.
   */
  async completeAuthorization(
    principal: Principal,
    id: string,
    q: CompleteInput,
  ): Promise<CallbackOutcome> {
    const outcome = (result: CallbackResult, connectionId?: string): CallbackOutcome => {
      this.ctx.metrics.oauthAuthorize(result);
      return connectionId ? { result, connectionId } : { result };
    };
    if (typeof q.state !== 'string' || !STATE_SHAPE.test(q.state)) return outcome('state_invalid');
    let pending;
    try {
      pending = await this.stores.pending.consume(q.state);
    } catch {
      return outcome('error');
    }
    if (!pending) return outcome('state_invalid');
    // A request of another tenant or connection looks like an unknown state.
    const own = (t: string, c: string) => t === principal.tenantId && c === id;
    if ('expired' in pending) {
      if (!own(pending.expired.tenantId, pending.expired.connectionId))
        return outcome('state_invalid');
      await this.auditDenied(pending.expired.tenantId, id, 'state_invalid');
      return outcome('state_expired', id);
    }
    const req = pending.request;
    if (!own(req.tenantId, req.connectionId)) return outcome('state_invalid');
    // The consent can be completed only by the session that started it: same person, and the
    // console of the browser that was sent to the authorization server holds the nonce. A link
    // that was forwarded to someone else leads nowhere (the other person has neither).
    const nonce = typeof q.nonce === 'string' && NONCE_SHAPE.test(q.nonce) ? q.nonce : null;
    if (
      req.userId !== principal.userId ||
      nonce === null ||
      !sameString(nonceHash(nonce), req.nonceHash)
    ) {
      await this.auditDenied(req.tenantId, id, 'nonce_mismatch');
      return outcome('forbidden', id);
    }
    const row = await this.rowOf({ id: req.connectionId, tenantId: req.tenantId });
    const cfg = row && oauthConfig(row);
    if (
      !row ||
      !cfg ||
      cfg.auth.grant !== 'authorization_code' ||
      row.credentialVersion !== req.credentialVersion ||
      canonicalResource(cfg.url) !== req.resource
    )
      return outcome('conflict', req.connectionId);
    const actor = `user:${req.userId}`;
    // The person must still be allowed to authorize this connection.
    try {
      if (!hasPermission(principal, 'connections:write')) throw new Error('forbidden');
      await this.catalog.getOwnConnection(principal, row.id);
      if (row.scope === 'platform') throw new Error('central');
    } catch {
      await this.auditDenied(req.tenantId, row.id, 'forbidden');
      return outcome('forbidden', row.id);
    }
    // RFC 9207: the issuer parameter is checked before the code or an error is looked at.
    const iss = verifyIssuerParameter(req.issuer, q.iss, req.issAdvertised);
    if (iss !== 'ok') {
      await this.auditDenied(req.tenantId, row.id, iss);
      return outcome(iss, row.id);
    }
    if (typeof q.error === 'string' && q.error !== '') {
      const code = CALLBACK_ERRORS.has(q.error) ? q.error : 'other';
      await this.audit.append({
        actor,
        tenantId: req.tenantId,
        action: 'mcp.oauth.denied',
        target: row.id,
        payload: { connection: row.id, code: 'authorization_refused', error: code },
      });
      return outcome('denied', row.id);
    }
    if (typeof q.code !== 'string' || !CODE_SHAPE.test(q.code))
      return outcome('code_invalid', row.id);

    const origin = this.originOf(row);
    let client: ClientCredentials;
    try {
      this.assertEndpointsAllowed(row, Object.values(req.endpoints));
      client = await this.clientOf(row, cfg, await this.resolverOf(row), req.issuer);
    } catch (e) {
      await this.denied(row, actor, e);
      return outcome('error', row.id);
    }
    let issued;
    try {
      issued = await requestToken(this.http(), {
        tokenEndpoint: req.endpoints.tokenEndpoint as string,
        grant: 'authorization_code',
        client,
        scope: req.scopes,
        resource: req.resource,
        code: q.code,
        codeVerifier: req.verifier,
        redirectUri: req.redirectUri,
        origin,
        now: this.ctx.now(),
        algsSupported: req.signingAlgs,
        ids: [row.tenantId, row.id],
      });
    } catch (e) {
      await this.audit.append({
        actor,
        tenantId: row.tenantId,
        action: 'mcp.oauth.refresh_failed',
        target: row.id,
        payload: {
          connection: row.id,
          error: e instanceof OaxError ? e.code.slice(0, 64) : 'error',
          phase: 'callback',
        },
      });
      return outcome(e instanceof TokenRequestError ? 'token_refused' : 'error', row.id);
    }
    this.register(row, issued.accessToken, issued.refreshToken, issued.expiresIn);
    for (const v of issued.sensitive) this.registerIfShaped(row, v);
    const granted = issued.scope ?? req.scopes;
    const previous = await this.prepareRevoke(row);
    try {
      await this.stores.tokens.put({
        tenantId: row.tenantId,
        connectionId: row.id,
        credentialVersion: row.credentialVersion,
        issuer: req.issuer,
        resource: req.resource,
        clientRef: req.clientRef,
        scopes: granted,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: issued.expiresIn
          ? new Date(this.ctx.now().getTime() + issued.expiresIn * 1000)
          : undefined,
        authorizedBy: req.userId,
        grantType: 'authorization_code',
        endpoints: req.endpoints,
      });
    } catch {
      // A change raced the consent (credential version, deletion): the freshly issued tokens must
      // not stay valid at the server with nobody holding them.
      await this.revokeIssued(row, client, req.endpoints.revocationEndpoint, issued);
      return outcome('conflict', row.id);
    }
    this.verified.set(`${row.id}:${row.credentialVersion}`, {
      at: this.ctx.now().getTime(),
      algs: req.signingAlgs,
    });
    await this.audit.append({
      actor,
      tenantId: row.tenantId,
      action: 'mcp.oauth.authorized',
      target: row.id,
      payload: {
        connection: row.id,
        issuer: req.issuer,
        grant: 'authorization_code',
        scopes: granted,
        by: req.userId,
      },
    });
    await previous?.run('reauthorized', actor, 'replaced');
    return outcome('ok', row.id);
  }

  private async auditDenied(tenantId: string, connectionId: string, code: string): Promise<void> {
    await this.audit
      .append({
        actor: 'system:mcp-oauth',
        tenantId,
        action: 'mcp.oauth.denied',
        target: connectionId,
        payload: { connection: connectionId, code },
      })
      .catch(() => undefined);
  }

  /** Best effort: tells the authorization server to forget tokens nobody stored (RFC 7009). */
  private async revokeIssued(
    row: ConnectionRow,
    client: ClientCredentials,
    endpoint: string | undefined,
    issued: { accessToken: string; refreshToken?: string | undefined },
  ): Promise<void> {
    if (!endpoint) return;
    const base = { endpoint, client, origin: this.originOf(row), now: this.ctx.now() };
    if (issued.refreshToken)
      await revokeToken(this.http(), {
        ...base,
        token: issued.refreshToken,
        hint: 'refresh_token',
      }).catch(() => undefined);
    await revokeToken(this.http(), {
      ...base,
      token: issued.accessToken,
      hint: 'access_token',
    }).catch(() => undefined);
  }

  /** A server asked for more scopes: record them and fail the connection closed until consent. */
  private async stepUp(
    row: Pick<ConnectionRow, 'id' | 'tenantId' | 'credentialVersion'>,
    token: string,
    needed: readonly string[],
  ): Promise<void> {
    const marked = await this.stores.tokens.requireStepUp(
      row.tenantId,
      row.id,
      row.credentialVersion,
      token,
      needed,
    );
    if (!marked) return;
    await this.audit.append({
      actor: SYSTEM_ACTOR,
      tenantId: row.tenantId,
      action: 'mcp.oauth.step_up_required',
      target: row.id,
      payload: { connection: row.id, scopes: [...needed] },
    });
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
    const oauth = cfg?.auth?.kind === 'oauth' ? cfg.auth : null;
    const code = oauth?.grant === 'authorization_code';
    // What the profiles (or the explicit list) ask for and the grant does not cover: a new consent.
    const missing = code && cfg ? requestedScopes(cfg).filter((x) => !granted.includes(x)) : [];
    const status = meta?.status ?? 'not_authorized';
    const pending = code
      ? await this.stores.pending.openFor(row.tenantId, row.id, actor.userId)
      : null;
    return {
      status,
      grant: meta?.grantType ?? oauth?.grant ?? 'client_credentials',
      issuer: meta?.issuer ?? null,
      pinnedIssuer: oauth?.issuer ?? null,
      scopes: granted,
      expiresAt: meta?.expiresAt?.toISOString() ?? null,
      authorizedAt: meta?.authorizedAt.toISOString() ?? null,
      authorizedBy: meta?.authorizedBy ?? null,
      lastError: meta?.lastError ?? null,
      endpointHosts: meta ? endpointHosts(meta.endpoints) : [],
      scopesWider: needed.length > 0 && granted.some((x) => !needed.includes(x)),
      registration: code ? oauth.client.registration : null,
      redirectUri: code ? this.safeRedirectUri() : null,
      scopesMissing: missing,
      requiredScopes: meta?.requiredScopes ?? [],
      reauthorizationNeeded:
        code &&
        (status === 'reauthorization_required' || (status === 'active' && missing.length > 0)),
      pendingExpiresAt: pending?.expiresAt.toISOString() ?? null,
    };
  }

  private safeRedirectUri(): string | null {
    try {
      return this.redirectUriOf();
    } catch {
      return null;
    }
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
    const busyKey = `${ref.tenantId}:${ref.id}`;
    const backoff = this.busyUntil.get(busyKey);
    if (backoff !== undefined) {
      if (this.ctx.now().getTime() < backoff) {
        this.ctx.metrics.oauthRefresh('busy');
        throw busyError();
      }
      this.busyUntil.delete(busyKey);
    }
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
    // `updated_at` of the row as the renewal read it under the lock (the last attempt wins).
    const seen: { at: Date } = { at: meta.updatedAt };
    try {
      as = await this.verifyPin(row, cfg, meta.issuer, meta.endpoints, origin);
      const resolver = await this.resolverOf(row);
      const client = await this.clientOf(row, cfg, resolver, meta.issuer);
      await this.renewBounded(row, cfg, as, client, origin, seen);
      this.ctx.metrics.oauthRefresh('ok');
      await this.audit.append({
        actor: SYSTEM_ACTOR,
        tenantId: row.tenantId,
        action: 'mcp.oauth.refreshed',
        target: row.id,
        payload: { connection: row.id, outcome: 'ok' },
      });
    } catch (e) {
      // No slot, a busy lock or a row somebody else just rewrote: nothing is wrong with the
      // credentials and nothing is recorded; the stored token is used while it lasts and the next
      // request renews again.
      if (
        e instanceof OaxError &&
        (e.code === 'mcp_renewal_busy' ||
          e.code === 'mcp_credential_busy' ||
          e.code === 'mcp_token_changed')
      ) {
        this.lastRefresh.delete(gapKey);
        if (e.code !== 'mcp_token_changed') {
          if (this.busyUntil.size > 5000) this.busyUntil.clear();
          this.busyUntil.set(busyKey, this.ctx.now().getTime() + BUSY_BACKOFF_MS);
        }
        this.ctx.metrics.oauthRefresh(e.code === 'mcp_token_changed' ? 'failed' : 'busy');
        throw e.code === 'mcp_token_changed'
          ? new OaxError('mcp_auth_refresh_failed', 'the access token is being renewed elsewhere')
          : busyError();
      }
      const permanent = await this.failRefresh(row, e, seen.at);
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
    const seen = this.verified.get(key);
    const fresh = seen !== undefined && this.ctx.now().getTime() - seen.at < DISCOVERY_TTL_MS;
    if (fresh) return this.pinnedMetadata(issuer, pinned, seen.algs);
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
    this.verified.set(key, { at: this.ctx.now().getTime(), algs: as.signingAlgs });
    return as;
  }

  private async pinnedMetadata(
    issuer: string,
    pin: Record<string, string>,
    signingAlgs: readonly string[] | undefined,
  ): Promise<AuthServerMetadata> {
    // Within the discovery window the pin itself is the truth for the endpoints; the signing
    // algorithms are those of the document that was verified (cached next to the time), so that a
    // key is not signed with an algorithm the server never accepted (a PS256-only server).
    return {
      issuer,
      tokenEndpoint: pin.tokenEndpoint as string,
      ...(pin.revocationEndpoint ? { revocationEndpoint: pin.revocationEndpoint } : {}),
      tokenAuthMethods: ['client_secret_basic', 'private_key_jwt'],
      ...(signingAlgs ? { signingAlgs: [...signingAlgs] } : {}),
      issParameterSupported: false,
    };
  }

  /**
   * {@link renewLocked} within the concurrency bound of this process. A renewal holds a database
   * connection across the call to the authorization server, so the number of renewals is limited
   * (per process and per tenant) and a renewal that finds no free slot fails at once instead of
   * waiting: the pool stays available for everything else. A write that lost the compare-and-swap
   * (the stored row was rewritten meanwhile) is tried once more: the second attempt re-reads the
   * row under the lock and finds it renewed, or renews it.
   */
  private async renewBounded(
    row: ConnectionRow,
    cfg: OauthConfig,
    as: AuthServerMetadata,
    client: ClientCredentials,
    origin: OauthOrigin,
    seen: { at: Date },
  ): Promise<void> {
    const release = this.limiter.tryAcquire(row.tenantId);
    if (!release) throw new OaxError('mcp_renewal_busy', 'too many token renewals are running');
    try {
      try {
        await this.renewLocked(row, cfg, as, client, origin, seen);
      } catch (e) {
        if (!(e instanceof OaxError && e.code === 'mcp_token_changed')) throw e;
        await this.renewLocked(row, cfg, as, client, origin, seen);
      }
    } finally {
      release();
    }
  }

  /**
   * Reads, renews and writes under a transaction-scoped advisory lock (one renewal at a time).
   *
   * Rotation of refresh tokens (authorization_code): once the server has answered, the old refresh
   * token may be dead, so the new pair must not be lost to a failed commit. The previous pair stays
   * in the row until the new one is written (one transaction); when the write or the commit fails,
   * the commit is retried in new transactions ({@link persistRotation}), and a pair that still
   * cannot be stored is kept in memory and written first by the next renewal. A process that dies
   * between the server's answer and the commit loses the pair: the server's reuse detection then
   * ends in `invalid_grant` and `reauthorization_required`, which is the safe direction.
   */
  private async renewLocked(
    row: ConnectionRow,
    cfg: OauthConfig,
    as: AuthServerMetadata,
    client: ClientCredentials,
    origin: OauthOrigin,
    seen: { at: Date },
  ): Promise<void> {
    const key = ownerKey(row.id, row.credentialVersion);
    const box: { rotation?: Rotation } = {};
    try {
      await this.ctx.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockCredential(tx, row.id, row.credentialVersion);
        const stored = await this.stores.tokens.open(
          row.tenantId,
          row.id,
          row.credentialVersion,
          tx,
        );
        if (!stored)
          throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
        seen.at = stored.meta.updatedAt;
        // Read under the lock: a writer that does not take it (a step-up requirement, a failure of
        // an earlier attempt) may have changed the status since the caller looked. Only an
        // `active` or `refresh_failed` row is renewed; anything else needs an administrator and a
        // renewal must not write over it (the write would set the row active and clear the
        // requirement). A pair this process still holds for the row is then of no use.
        if (stored.meta.status !== 'active' && stored.meta.status !== 'refresh_failed') {
          const stale = this.unpersisted.get(key);
          if (stale) {
            this.unpersisted.delete(key);
            await this.revokeIssued(row, client, as.revocationEndpoint, stale.write);
          }
          throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
        }
        const nowMs = this.ctx.now().getTime();
        // A pair this process obtained earlier and could not store goes first, with no request
        // (before the freshness check: the stored refresh token may already be dead).
        const held = this.unpersisted.get(key);
        if (held) {
          // The row is still the one that was rotated (a failed attempt only touches its status).
          if (stored.refreshToken === held.previousRefresh) {
            await this.stores.tokens.write(tx, held.write, { updatedAt: stored.meta.updatedAt });
            this.unpersisted.delete(key);
            return;
          }
          // The row changed meanwhile: the held tokens will not be stored, tell their server.
          this.unpersisted.delete(key);
          await this.revokeIssued(row, client, as.revocationEndpoint, held.write);
        }
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
        // always renewed with a new grant, so a lost rotated token can never lock the connection
        // out. An authorization code can only be renewed with its refresh token.
        const code = stored.meta.grantType === 'authorization_code';
        if (code && stored.refreshToken === null)
          throw new OaxError('mcp_no_refresh_token', 'the grant has no refresh token');
        const useRefresh = code;
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
        box.rotation = {
          replace: stored.meta.updatedAt,
          previousRefresh: stored.refreshToken,
          write: {
            tenantId: row.tenantId,
            connectionId: row.id,
            credentialVersion: row.credentialVersion,
            issuer: stored.meta.issuer,
            resource,
            clientRef: stored.meta.clientRef ?? (cfg.auth.client.clientIdSecret as string),
            scopes: issued.scope ?? stored.meta.scopes,
            accessToken: issued.accessToken,
            refreshToken:
              issued.refreshToken ?? (useRefresh ? (stored.refreshToken ?? undefined) : undefined),
            expiresAt: issued.expiresIn ? new Date(nowMs + issued.expiresIn * 1000) : undefined,
            authorizedBy: stored.meta.authorizedBy ?? undefined,
            grantType: stored.meta.grantType as 'client_credentials' | 'authorization_code',
            endpoints: stored.meta.endpoints,
          },
        };
        await this.stores.tokens.write(tx, box.rotation.write, {
          updatedAt: stored.meta.updatedAt,
        });
      });
    } catch (e) {
      const r = box.rotation;
      if (!r) throw e;
      if (
        e instanceof OaxError &&
        e.code === 'mcp_token_changed' &&
        r.write.grantType === 'authorization_code'
      ) {
        // The server has rotated the refresh token: the stored one is dead, so the new pair must
        // not be thrown away. It is held and written over the very row it replaces by the retry
        // (or the next renewal), which revokes it instead if the row turned out to be different.
        this.unpersisted.set(key, r);
        if (this.unpersisted.size > 1000) this.unpersisted.clear();
        throw e;
      }
      if (e instanceof OaxError && DETERMINISTIC.has(e.code)) {
        // The row changed or went away while the server answered: nobody will hold these tokens.
        await this.revokeIssued(row, client, as.revocationEndpoint, r.write);
        throw e;
      }
      await this.persistRotation(row, key, r);
    }
  }

  /**
   * Commits a rotated pair after the first attempt failed: new transactions, short pauses, only
   * over the very row the renewal read. If every attempt fails the pair is kept in memory (it is
   * already registered with the redactors) and the renewal fails; the next renewal stores it.
   */
  private async persistRotation(row: ConnectionRow, key: string, r: Rotation): Promise<void> {
    for (const pause of this.rotationRetryMs) {
      await new Promise((resolve) => setTimeout(resolve, pause));
      try {
        await this.ctx.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          await lockCredential(tx, row.id, row.credentialVersion);
          await this.stores.tokens.write(tx, r.write, { updatedAt: r.replace });
        });
        this.unpersisted.delete(key);
        return;
      } catch (e) {
        if (e instanceof OaxError && DETERMINISTIC.has(e.code)) {
          this.unpersisted.delete(key);
          throw e;
        }
      }
    }
    this.unpersisted.set(key, r);
    if (this.unpersisted.size > 1000) this.unpersisted.clear();
    throw new OaxError(
      'mcp_auth_refresh_failed',
      'the renewed token could not be stored; it is written by the next renewal',
    );
  }

  /** Records the failure; true when the credentials are rejected for good. */
  private async failRefresh(row: ConnectionRow, e: unknown, seen: Date): Promise<boolean> {
    // The row is gone or needs an administrator already (deleted, step-up, rejected): there is
    // nothing to record, and recording would put a renewable status over that state.
    if (e instanceof OaxError && e.code === 'mcp_auth_required') {
      this.ctx.metrics.oauthRefresh('failed');
      return true;
    }
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
      [
        'mcp_issuer_mismatch',
        'mcp_oauth_endpoints_changed',
        'mcp_resource_mismatch',
        'mcp_no_refresh_token',
      ].includes(e.code)
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
    // Only over the row this renewal saw: tokens written meanwhile (a new authorization, a renewal
    // on another replica) are not marked by a failure that belongs to the old ones.
    const recorded = await this.stores.tokens
      .recordFailure(row.tenantId, row.id, row.credentialVersion, status, code.slice(0, 64), seen)
      .catch(() => true);
    if (!recorded) {
      this.ctx.metrics.oauthRefresh('failed');
      return false;
    }
    this.ctx.metrics.oauthRefresh(outcome);
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
    const held: {
      token: string;
      hint: 'access_token' | 'refresh_token';
      issuer: string;
      endpoint?: string;
    }[] = [];
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
        issuer: stored.meta.issuer,
        ...(endpoint ? { endpoint } : {}),
      });
      if (stored.refreshToken)
        held.push({
          token: stored.refreshToken,
          hint: 'refresh_token',
          issuer: stored.meta.issuer,
          ...(endpoint ? { endpoint } : {}),
        });
    }
    const config = row.config;
    const full = row as ConnectionRow;
    return {
      run: async (reason, actor = SYSTEM_ACTOR, rows = 'delete') => {
        // First, and not swallowed: when the credential lock cannot be had (a renewal that is
        // stuck on a stalled server) the disconnect fails with 503 mcp_credential_busy, nothing is
        // revoked or audited as done, and the caller can simply try again.
        if (rows === 'delete') await this.stores.tokens.delete(row.tenantId, row.id);
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
            const resolver = await this.resolverOf(full);
            const clients = new Map<string, ClientCredentials>();
            remote = 'ok';
            for (const t of targets) {
              let client = clients.get(t.issuer);
              if (!client) {
                client = await this.clientOf(full, cfg, resolver, t.issuer);
                clients.set(t.issuer, client);
              }
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
    // An open consent request must not complete after the connection was disconnected.
    await this.stores.pending.deleteFor(row.tenantId, row.id);
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
