import { classificationRank, type Classification } from '../classification.js';
import {
  NETWORK_PURPOSES,
  compileProxyUrl,
  type CompiledNetwork,
  type CompiledProxy,
  type CompiledRoute,
  type NetworkPurpose,
} from './config.js';
import { matchesAny, normalizeTarget, type NormalizedTarget } from './hosts.js';
import { NEVER_PRIVATE_CLASSES, classifyAddress, isMetadataName } from './ip.js';

/** Who a request is made for and what the caller already decided about its connection. */
export interface RouteScope {
  /** `platform` = operator-configured destination; `tenant` = tenant-supplied connection. */
  origin?: 'platform' | 'tenant';
  tenantId?: string;
  /** The connection's explicit `network.proxy`: a configured proxy name or `direct`. */
  proxy?: string;
  /** The connection's `network.clientCertificate` (a name from the platform configuration). */
  clientCertificate?: string;
  /** Legacy per-connection `proxyUrl` (deprecated). */
  proxyUrl?: string;
  /** True for an existing tenant connection that already had a `proxyUrl` and is unchanged. */
  proxyUrlGrandfathered?: boolean;
  /** Classification of the data of the run: capped by proxies that inspect traffic. */
  classification?: Classification;
}

export type DenyCode =
  | 'invalid_target'
  | 'invalid_purpose'
  | 'metadata_destination'
  | 'destination_not_public'
  | 'plain_http_refused'
  | 'proxy_unknown'
  | 'proxy_not_selectable'
  | 'proxy_url_not_allowed'
  | 'proxy_url_invalid'
  | 'client_certificate_unknown'
  | 'client_certificate_not_selectable'
  | 'proxy_unsupported_scheme'
  | 'classification_exceeds_route'
  | 'egress_denied'
  | 'proxy_not_allowlisted';

export interface ResolvedProxy {
  name: string;
  /** Credential-free origin. */
  url: string;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  /** Secret reference of the Proxy-Authorization value (never the value). */
  authSecret?: string;
  caBundle?: string;
  tlsInspection: boolean;
  source: CompiledProxy['source'];
  /** The URL came from the environment/legacy setting and carries userinfo that must be read there. */
  envUserinfo?: boolean;
}

export interface RouteResolution {
  decision: 'direct' | 'proxy' | 'deny';
  /** `direct`, the proxy name, or `deny` (ADR 0011). */
  via: string;
  /** Which rule decided: a route name, `connection:<proxy>`, `legacy-proxyUrl`, `legacy-env`, `default`. */
  routeName: string;
  proxy?: ResolvedProxy;
  /** Trust store to use for the destination (bundle names; resolved by the dispatcher factory). */
  ca: { mode: 'system+extra' | 'extra-only'; bundles: readonly string[] };
  clientCert?: string;
  /** Present exactly when `decision` is `deny`; also the audit/error code. */
  code?: DenyCode;
  /** Human-readable reasons in the order the rules were applied. Never contains credentials. */
  reasons: string[];
  /** Normalised destination (no userinfo, path or query). */
  target?: { scheme: string; host: string; port: number };
}

/**
 * Purposes whose traffic carries secrets or tenant data and must not use plain `http://` (or
 * plain `ldap://`). `mcp` is deliberately not in the set for platform-configured servers (an
 * in-cluster MCP server over http is a normal deployment); tenant-supplied MCP servers are
 * TLS-only (see `tlsOnly` below).
 */
const TLS_ONLY_PURPOSES: ReadonlySet<NetworkPurpose> = new Set([
  'model',
  'identity',
  'git',
  'webhook',
]);

function isPurpose(v: string): v is NetworkPurpose {
  return (NETWORK_PURPOSES as readonly string[]).includes(v);
}

const asResolved = (p: CompiledProxy): ResolvedProxy => {
  const { maxClassification: _unused, ...rest } = p;
  void _unused;
  return rest;
};

function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/** Schemes that cannot be tunnelled through an HTTP proxy by this platform. */
const NON_HTTP_SCHEMES: ReadonlySet<string> = new Set(['ldap', 'ldaps']);

/**
 * Resolves how a request leaves the platform. Pure: no DNS, no network, no clock, no logging.
 * Precedence (ADR 0011 section 1): the connection's explicit `network.proxy`, the legacy
 * per-connection `proxyUrl`, the configured routes (first match wins), the legacy environment,
 * direct. Safety rules apply before and after the precedence: metadata destinations, a `deny`
 * route, tenant destination checks, plain-http refusal, classification caps and the air-gapped
 * allowlist (target and proxy host) can only refuse, never widen.
 *
 * `net` is an explicit argument (ADR sketches `resolveRoute(url, purpose, scope)`): the function
 * has no hidden global state.
 */
export function resolveRoute(
  url: string | URL,
  purpose: NetworkPurpose,
  scope: RouteScope,
  net: CompiledNetwork,
): RouteResolution {
  const ca = { mode: net.trust.mode, bundles: net.trust.bundles } as const;
  const reasons: string[] = [];
  const deny = (
    code: DenyCode,
    reason: string,
    routeName: string,
    target?: NormalizedTarget | null,
  ): RouteResolution => {
    reasons.push(reason);
    return {
      decision: 'deny',
      via: 'deny',
      routeName,
      ca,
      code,
      reasons,
      ...(target
        ? { target: { scheme: target.scheme, host: target.host, port: target.port } }
        : {}),
    };
  };

  if (!isPurpose(purpose)) return deny('invalid_purpose', 'unknown purpose', 'default');
  const target = normalizeTarget(url);
  if (!target)
    return deny(
      'invalid_target',
      'destination is not a valid http(s)/ws(s)/ldap(s) URL',
      'default',
    );
  const origin = scope.origin ?? 'platform';
  const where = `${target.host}:${target.port}`;

  // 1. Cloud metadata services are never reachable, whoever asks.
  if (isMetadataName(target.host) || (target.ip && classifyAddress(target.ip) === 'metadata'))
    return deny('metadata_destination', `${where} is a cloud metadata address`, 'default', target);

  // privateAllow can open private ranges only: never loopback, link-local, unspecified,
  // multicast or metadata space, whatever the list says (defence in depth next to validation).
  const privateOk = privateAllowed(net, target);
  const loopback =
    isLocalName(target.host) || (target.ip && classifyAddress(target.ip) === 'loopback');

  // 2. Tenant-supplied destinations must be public by name (the address check is the dispatcher's).
  if (origin === 'tenant' && !privateOk) {
    if (isLocalName(target.host) || target.host === 'localhost')
      return deny(
        'destination_not_public',
        `${where}: local names are not allowed for tenant destinations`,
        'default',
        target,
      );
    if (target.ip && classifyAddress(target.ip) !== 'public')
      return deny(
        'destination_not_public',
        `${where}: a non-public address is not allowed for tenant destinations`,
        'default',
        target,
      );
  }

  // 3. No plain http for traffic that carries keys or tenant data (outside loopback/private-allow).
  const tlsOnly = TLS_ONLY_PURPOSES.has(purpose) || (purpose === 'mcp' && origin === 'tenant');
  const plain =
    target.scheme === 'http' ||
    target.scheme === 'ws' ||
    (target.scheme === 'ldap' && purpose === 'identity');
  if (plain && tlsOnly && !loopback && !privateOk)
    return deny(
      'plain_http_refused',
      `${purpose} traffic to ${where} must use TLS`,
      'default',
      target,
    );

  // Every `deny` route vetoes, wherever it sits in the list: a broader route in front of it must
  // not shadow it. The first matching other route is used for the proxy and the certificate.
  const applies = (r: CompiledRoute) =>
    (r.purposes === null || r.purposes.has(purpose)) && matchesAny(r.patterns, target);
  const denyRoute = net.routes.find((r) => r.via === 'deny' && applies(r));
  if (denyRoute)
    return deny(
      'egress_denied',
      `route "${denyRoute.name}" denies ${where}`,
      denyRoute.name,
      target,
    );
  const route: CompiledRoute | undefined = net.routes.find(applies);

  // A tenant may only name a client certificate the operator opened for tenants, and can never
  // override the certificate of the matching route.
  if (
    origin === 'tenant' &&
    scope.clientCertificate !== undefined &&
    !net.tenantSelectableCertificates.has(scope.clientCertificate)
  )
    return deny(
      'client_certificate_not_selectable',
      'the client certificate is not selectable by tenants',
      route?.name ?? 'default',
      target,
    );
  const certName =
    origin === 'tenant'
      ? (route?.clientCertificate ?? scope.clientCertificate)
      : (scope.clientCertificate ?? route?.clientCertificate);
  if (certName !== undefined && !net.clientCertificates.has(certName))
    return deny(
      'client_certificate_unknown',
      `client certificate "${certName}" is not configured`,
      route?.name ?? 'default',
      target,
    );

  const finish = (
    proxyIn: CompiledProxy | null,
    routeName: string,
    why: string,
  ): RouteResolution => {
    reasons.push(why);
    let proxy = proxyIn;
    if (proxy && NON_HTTP_SCHEMES.has(target.scheme)) {
      // LDAP is never tunnelled through an HTTP proxy. The implicit environment route simply does
      // not apply (existing installs keep working); an explicit proxy choice is refused.
      if (routeName !== 'legacy-env')
        return deny(
          'proxy_unsupported_scheme',
          `${target.scheme} cannot be sent through an HTTP proxy`,
          routeName,
          target,
        );
      reasons.push(`${target.scheme} is never sent through an HTTP proxy; going direct`);
      proxy = null;
    }
    if (proxy) {
      if (
        proxy.maxClassification &&
        scope.classification &&
        classificationRank(scope.classification) > classificationRank(proxy.maxClassification)
      )
        return deny(
          'classification_exceeds_route',
          `${scope.classification} data may not pass proxy "${proxy.name}" (max ${proxy.maxClassification})`,
          routeName,
          target,
        );
    }
    const eg = net.egress;
    if (eg?.airgapped) {
      if (!eg.isAllowed(target.host, target.port))
        return deny(
          'egress_denied',
          `air-gapped: ${where} is not on the allowlist`,
          routeName,
          target,
        );
      if (proxy && !eg.isAllowed(proxy.host, proxy.port))
        return deny(
          'proxy_not_allowlisted',
          `air-gapped: proxy "${proxy.name}" host is not on the allowlist`,
          routeName,
          target,
        );
    }
    return {
      decision: proxy ? 'proxy' : 'direct',
      via: proxy ? proxy.name : 'direct',
      routeName,
      ...(proxy ? { proxy: asResolved(proxy) } : {}),
      ca,
      ...(certName !== undefined ? { clientCert: certName } : {}),
      reasons,
      target: { scheme: target.scheme, host: target.host, port: target.port },
    };
  };

  // Loopback is never sent to a proxy (a proxy cannot reach it and would only see local traffic)
  // unless the connection explicitly asks for one.
  if (loopback && scope.proxy === undefined && scope.proxyUrl === undefined)
    return finish(null, 'loopback', 'loopback destinations are always direct');

  // 4. The connection's explicit selection.
  if (scope.proxy !== undefined) {
    if (scope.proxy === 'direct') {
      if (origin === 'tenant' && !net.tenantDirect)
        return deny(
          'proxy_not_selectable',
          'direct access is not enabled for tenants',
          'connection:direct',
          target,
        );
      return finish(null, 'connection:direct', 'connection selected direct');
    }
    const p = net.proxies.get(scope.proxy);
    if (!p)
      return deny(
        'proxy_unknown',
        `proxy "${scope.proxy}" is not configured`,
        'connection',
        target,
      );
    if (origin === 'tenant' && !net.tenantSelectable.has(p.name))
      return deny(
        'proxy_not_selectable',
        `proxy "${p.name}" is not selectable by tenants`,
        `connection:${p.name}`,
        target,
      );
    if (origin === 'tenant' && scope.proxyUrl !== undefined && !scope.proxyUrlGrandfathered)
      return deny(
        'proxy_url_not_allowed',
        'a tenant connection must not carry a proxyUrl',
        `connection:${p.name}`,
        target,
      );
    return finish(p, `connection:${p.name}`, `connection selected proxy "${p.name}"`);
  }

  // 5. Legacy per-connection proxyUrl (NO_PROXY still applies).
  if (scope.proxyUrl !== undefined) {
    if (origin === 'tenant' && !scope.proxyUrlGrandfathered)
      return deny(
        'proxy_url_not_allowed',
        'a tenant connection must not set proxyUrl; select a named proxy with network.proxy',
        'legacy-proxyUrl',
        target,
      );
    if (matchesAny(net.legacy.noProxy, target))
      return finish(
        null,
        'legacy-proxyUrl',
        'NO_PROXY matches, the connection proxyUrl is bypassed',
      );
    const p = compileLegacy(scope.proxyUrl);
    if (!p)
      return deny(
        'proxy_url_invalid',
        'proxyUrl is not a valid http(s) proxy URL',
        'legacy-proxyUrl',
        target,
      );
    // A tenant-chosen proxy host is a destination the platform connects to: it must be public
    // (or in privateAllow) and never a metadata address, grandfathered or not.
    if (origin === 'tenant') {
      const at = normalizeTarget(p.url);
      const isMeta =
        !at || isMetadataName(at.host) || (at.ip && classifyAddress(at.ip) === 'metadata');
      const nonPublic =
        !!at &&
        (isLocalName(at.host) || (!!at.ip && classifyAddress(at.ip) !== 'public')) &&
        !privateAllowed(net, at);
      if (isMeta || nonPublic)
        return deny(
          'proxy_url_not_allowed',
          'the proxyUrl host is a metadata or non-public address',
          'legacy-proxyUrl',
          target,
        );
    }
    return finish(p, 'legacy-proxyUrl', 'legacy connection proxyUrl (deprecated)');
  }

  // 6. Configured routes.
  if (route) {
    if (route.via === 'direct') return finish(null, route.name, `route "${route.name}" is direct`);
    const p = net.proxies.get(route.via);
    if (!p)
      return deny(
        'proxy_unknown',
        `route "${route.name}" names an unknown proxy`,
        route.name,
        target,
      );
    return finish(p, route.name, `route "${route.name}" via proxy "${p.name}"`);
  }

  // 7. Legacy environment as the implicit last route.
  const envProxy =
    target.scheme === 'https' || target.scheme === 'wss'
      ? (net.legacy.httpsProxy ?? net.legacy.httpProxy)
      : net.legacy.httpProxy;
  if (envProxy) {
    if (matchesAny(net.legacy.noProxy, target))
      return finish(null, 'legacy-env', 'NO_PROXY matches');
    return finish(envProxy, 'legacy-env', 'environment proxy (HTTPS_PROXY/HTTP_PROXY)');
  }

  return finish(null, 'default', 'no route matches; direct');
}

function privateAllowed(net: CompiledNetwork, target: NormalizedTarget): boolean {
  if (target.ip && NEVER_PRIVATE_CLASSES.has(classifyAddress(target.ip))) return false;
  return matchesAny(net.privateAllow, target);
}

function compileLegacy(raw: string): CompiledProxy | null {
  return compileProxyUrl(raw, 'connection', 'connection');
}
