import { createHash } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, rootCertificates, type ConnectionOptions } from 'node:tls';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import {
  NetworkConfigSchema,
  OaxError,
  assertTlsVerificationOn,
  compileNetwork,
  legacyProxyFromEnv,
  readConfigFile,
  resolveRoute,
  type CompiledNetwork,
  type NetworkPurpose,
  type RouteResolution,
  type RouteScope,
} from '@openagentix/core';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertPublicDestination, createPinnedLookup, type HostLookup } from './ssrf.js';

/**
 * The one place where outbound HTTP(S) clients get their connection (ADR 0011, amendment 3).
 *
 * For every request the factory asks the pure resolver (`resolveRoute`) how the request leaves the
 * platform and builds the matching undici dispatcher: direct with a pinned DNS lookup, or through
 * the selected HTTP(S) proxy (CONNECT for https targets). Trust store and client certificate come
 * from the network configuration. A `deny` or veto result is an `egress_denied` error; redirects
 * are never followed; connect/header/body timeouts and a response size limit always apply.
 *
 * DNS pinning limitation: behind an HTTP proxy the PROXY resolves the destination name, so the
 * destination address cannot be pinned or checked here. Only the pre-request checks of the
 * resolver (name, literal address, metadata veto, air-gapped allowlist) apply for proxied
 * requests. The proxy host itself is pinned (checked at connect time) when it was chosen by a
 * tenant (`origin: 'tenant'` scope), which is the only case where the proxy address is not
 * operator-trusted; a proxy named by the operator (configuration, environment, platform
 * `proxyUrl`) may live in a private network. For tenant requests through a proxy the factory
 * additionally resolves the destination name once before sending (`assertPublicDestination`);
 * the proxy's own resolution can still differ from that check (residual risk, ADR 0011).
 *
 * Certificate verification is always on: every TLS option set carries `rejectUnauthorized: true`
 * and the factory refuses to run when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.
 */

/** Reads a secret by reference name. Synchronous: callers pre-load a snapshot (never a URL). */
export type SecretReader = (ref: string) => string | undefined;

export interface OutboundLimits {
  /** TCP/TLS connect timeout (ms). Default 15 000. */
  connectTimeoutMs?: number;
  /** Time to the response headers (ms). Default 300 000 (LLMs can think for a while). */
  headersTimeoutMs?: number;
  /** Max idle time between body chunks (ms). Default 300 000. */
  bodyTimeoutMs?: number;
  /** Upper bound of the response body in bytes. Default 64 MiB; exceeding it errors the stream. */
  maxResponseBytes?: number;
}

export interface OutboundOptions {
  /** Compiled network configuration. Default: only the legacy HTTPS_PROXY/HTTP_PROXY/NO_PROXY env. */
  network?: CompiledNetwork | undefined;
  env?: Record<string, string | undefined> | undefined;
  secrets?: SecretReader | undefined;
  /** Reads a trust-bundle file (absolute path). Default: size-limited regular-file read. */
  readFile?: ((path: string) => string) | undefined;
  limits?: OutboundLimits | undefined;
  /**
   * Compatibility mode for callers that are not yet configured through the network configuration:
   * platform destinations may use plain `http://` (in-cluster model servers), as before. Ignored
   * for tenant-origin requests. Default false.
   */
  allowPlainHttpForPlatform?: boolean | undefined;
  /** Called for every routing decision (allowed or denied); the argument never holds secrets. */
  onRoute?: ((audit: RouteAudit) => void) | undefined;
  /** Test seam: replaces the undici fetch. */
  fetchImpl?:
    | ((
        url: string,
        init: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown },
      ) => Promise<Response>)
    | undefined;
}

export interface OutboundContext {
  purpose: NetworkPurpose;
  scope?: RouteScope | undefined;
  /**
   * Connect-time DNS pinning for direct requests: every resolved address must be public (or in
   * `allow` / the network `privateAllow`). Tenant-origin requests are always pinned.
   */
  pin?: { allow?: readonly string[] | undefined; lookup?: HostLookup | undefined } | undefined;
  /** Total time limit for this request in addition to the dispatcher timeouts (ms). */
  timeoutMs?: number | undefined;
}

/** Routing decision for logs and audit. Contains no credentials, paths or query strings. */
export interface RouteAudit {
  purpose: NetworkPurpose;
  decision: RouteResolution['decision'];
  via: string;
  routeName: string;
  code?: string | undefined;
  target?: { scheme: string; host: string; port: number } | undefined;
  clientCertificate?: string | undefined;
  trust: { mode: string; bundles: readonly string[] };
  /** The connect step validated the destination address (false behind a proxy). */
  pinned: boolean;
  /** The proxy resolves the destination name (pinning impossible; documented limitation). */
  proxyResolves: boolean;
  reasons: readonly string[];
}

export interface OutboundPlan {
  route: RouteResolution;
  audit: RouteAudit;
  dispatcher: Dispatcher;
}

export interface NodeAgents {
  route: RouteResolution;
  audit: RouteAudit;
  httpsAgent: HttpsAgent;
  httpAgent?: HttpAgent;
}

export interface OutboundDispatcher {
  /** Resolves the route and returns (or builds) the dispatcher. Throws `egress_denied` on deny. */
  plan(url: string | URL, ctx: OutboundContext): OutboundPlan;
  /** fetch through the planned dispatcher: no redirects, timeouts, size limit. */
  fetch(url: string | URL, init: RequestInit | undefined, ctx: OutboundContext): Promise<Response>;
  /** The same routing for Node http(s) agents (AWS SDK). */
  nodeAgents(url: string | URL, ctx: OutboundContext): NodeAgents;
  /**
   * A raw TCP stream to `host:port` for a protocol the caller speaks itself (the Git relay, ADR 0010
   * Amendment 1 A1.5): direct to the checked and pinned address, or through the selected proxy
   * with `CONNECT`. The route decision, the air-gapped allowlist and the pinning rules are the
   * same as for `plan`; TLS (if any) stays end to end between the caller and the destination.
   * Throws `egress_denied` on a deny result.
   */
  dial(target: { host: string; port: number }, ctx: OutboundContext): Promise<Socket>;
  /** The effective network (for diagnostics). */
  readonly network: CompiledNetwork;
  /** Closes every cached dispatcher (config reload, shutdown). */
  close(): Promise<void>;
}

const MiB = 1024 * 1024;
const DEFAULTS = {
  connectTimeoutMs: 15_000,
  headersTimeoutMs: 300_000,
  bodyTimeoutMs: 300_000,
  maxResponseBytes: 64 * MiB,
} as const;

/** Network built from the environment only: the behaviour of installs without a network file. */
export function legacyNetwork(env: Record<string, string | undefined> = process.env) {
  return compileNetwork(NetworkConfigSchema.parse({}), { legacy: legacyProxyFromEnv(env) });
}

const deniedError = (r: RouteResolution) =>
  new OaxError('egress_denied', `outbound request refused (${r.code ?? 'egress_denied'})`, {
    code: r.code,
    routeName: r.routeName,
    target: r.target,
  });

function audit(
  purpose: NetworkPurpose,
  r: RouteResolution,
  net: CompiledNetwork,
  pinned: boolean,
): RouteAudit {
  return {
    purpose,
    decision: r.decision,
    via: r.via,
    routeName: r.routeName,
    ...(r.code ? { code: r.code } : {}),
    ...(r.target ? { target: r.target } : {}),
    ...(r.clientCert ? { clientCertificate: r.clientCert } : {}),
    trust: { mode: net.trust.mode, bundles: net.trust.bundles },
    pinned: r.decision === 'direct' && pinned,
    proxyResolves: r.decision === 'proxy',
    reasons: r.reasons,
  };
}

/** Value of the Proxy-Authorization header from "user:password" or a full header value. */
export function proxyAuthorization(raw: string): string {
  return /^(Basic|Bearer) \S/.test(raw)
    ? raw
    : `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Credentials of a proxy URL. An unparsable URL has none (routing refuses it separately); invalid
 * percent-encoding is an error, never a silently dropped `Proxy-Authorization`.
 */
function userinfo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
  if (!u.username && !u.password) return undefined;
  try {
    return `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  } catch {
    throw new OaxError(
      'network_config_invalid',
      'the proxy credentials contain invalid percent-encoding',
    );
  }
}

/** The OaxError itself or the first one in the `cause` chain (undici: "fetch failed" + cause). */
export function findOaxError(e: unknown): OaxError | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    // ProviderError (code provider_error) is the retry layer's own type, not a policy error
    if (cur instanceof OaxError && cur.code !== 'provider_error') return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 32);

const MAX_CACHED_DISPATCHERS = 64;

/** CONNECT tunnel agent: proxy-hop TLS (constructor options) and destination TLS kept apart. */
class TunnelAgent extends HttpsProxyAgent<string> {
  constructor(
    proxyUrl: string,
    proxyOptions: ConstructorParameters<typeof HttpsProxyAgent<string>>[1],
    private readonly targetTls: ConnectionOptions,
  ) {
    super(proxyUrl, proxyOptions);
  }

  /**
   * https-proxy-agent builds the TLS session to the DESTINATION from the request options handed
   * to `connect`, and the proxy socket from the constructor options. Trust and client certificate
   * of the destination are therefore injected here, so they neither replace the proxy's trust
   * nor reach the proxy.
   */
  override connect(
    req: ClientRequest,
    opts: Parameters<HttpsProxyAgent<string>['connect']>[1],
  ): ReturnType<HttpsProxyAgent<string>['connect']> {
    return super.connect(req, { ...opts, ...this.targetTls } as typeof opts);
  }
}

function limitBody(res: Response, max: number): Response {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    throw new OaxError('response_too_large', 'the response is larger than the allowed size');
  }
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max)
          controller.error(
            new OaxError('response_too_large', 'the response exceeded the allowed size'),
          );
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export function createOutboundDispatcher(opts: OutboundOptions = {}): OutboundDispatcher {
  const env = opts.env ?? process.env;
  assertTlsVerificationOn(env);
  let netCache: CompiledNetwork | undefined = opts.network;
  const net = (): CompiledNetwork => (netCache ??= legacyNetwork(env));
  const limits = { ...DEFAULTS, ...stripUndefined(opts.limits) };
  const readFile = opts.readFile ?? readConfigFile;
  /** Insertion order = recency (LRU): hits are re-inserted, the oldest entry is evicted. */
  const dispatchers = new Map<string, Dispatcher>();
  const pems = new Map<string, string>();

  const secret = (ref: string): string => {
    const v = opts.secrets?.(ref);
    if (!v) throw new OaxError('network_secret_unavailable', `secret "${ref}" is not available`);
    return v;
  };

  const bundlePem = (name: string): string => {
    const hit = pems.get(name);
    if (hit !== undefined) return hit;
    const b = net().config.trust.bundles.find((x) => x.name === name);
    if (!b) throw new OaxError('network_config_invalid', `unknown trust bundle "${name}"`);
    const pem = b.file ? readFile(b.file) : secret(b.secret ?? '');
    pems.set(name, pem);
    return pem;
  };

  /** CA list: system roots (mode system+extra) plus the named bundles. undefined = Node default. */
  const caList = (bundles: readonly string[]): string[] | undefined => {
    const extra = bundles.map(bundlePem);
    if (net().trust.mode === 'system+extra' && extra.length === 0) return undefined;
    return net().trust.mode === 'system+extra' ? [...rootCertificates, ...extra] : extra;
  };

  const clientCert = (name: string | undefined) => {
    if (!name) return {};
    const c = net().config.clientCertificates.find((x) => x.name === name);
    if (!c) throw new OaxError('client_certificate_unknown', `client certificate "${name}"`);
    return { cert: secret(c.certSecret), key: secret(c.keySecret) };
  };

  const resolve = (url: string | URL, ctx: OutboundContext) => {
    assertTlsVerificationOn(env);
    const n = net();
    const scope = ctx.scope ?? {};
    const route = resolveRoute(
      url,
      ctx.purpose,
      {
        ...scope,
        ...(opts.allowPlainHttpForPlatform && scope.origin !== 'tenant'
          ? { allowPlainHttp: true }
          : {}),
      },
      n,
    );
    const pinned = ctx.scope?.origin === 'tenant' || ctx.pin !== undefined;
    const a = audit(ctx.purpose, route, n, pinned);
    opts.onRoute?.(a);
    if (route.decision === 'deny') throw deniedError(route);
    return { route, audit: a, pinned, scope };
  };

  const pinLookup = (ctx: OutboundContext) =>
    createPinnedLookup({
      allow: [...(ctx.pin?.allow ?? []), ...net().config.privateAllow],
      ...(ctx.pin?.lookup ? { lookup: ctx.pin.lookup } : {}),
    }) as never;

  /** Proxy credentials: configured secret, else userinfo of the env / legacy connection URL. */
  const proxyToken = (route: RouteResolution, scope: RouteScope): string | undefined => {
    const p = route.proxy;
    if (!p) return undefined;
    if (p.authSecret) return proxyAuthorization(secret(p.authSecret));
    let raw: string | undefined;
    if (route.routeName === 'legacy-proxyUrl') raw = userinfo(scope.proxyUrl);
    else if (p.envUserinfo)
      raw = userinfo(
        p.name === 'env:https'
          ? (env.HTTPS_PROXY ?? env.https_proxy)
          : (env.HTTP_PROXY ?? env.http_proxy),
      );
    return raw ? proxyAuthorization(raw) : undefined;
  };

  /** TLS options for the DESTINATION (trust incl. an inspecting proxy's CA, client certificate). */
  const targetTls = (route: RouteResolution) => {
    const p = route.proxy;
    const destCa = caList(
      p?.tlsInspection && p.caBundle ? [...route.ca.bundles, p.caBundle] : route.ca.bundles,
    );
    return {
      ...(destCa ? { ca: destCa } : {}),
      ...clientCert(route.clientCert),
      rejectUnauthorized: true as const,
    };
  };

  /** The proxy connect step is validated when the proxy was not chosen by the operator. */
  const pinProxy = (scope: RouteScope) => scope.origin === 'tenant';

  const build = (r: ReturnType<typeof resolve>, ctx: OutboundContext): Dispatcher => {
    const { route, scope } = r;
    const p = route.proxy;
    const common = targetTls(route);
    const timeouts = {
      headersTimeout: limits.headersTimeoutMs,
      bodyTimeout: limits.bodyTimeoutMs,
    };
    if (p) {
      const token = proxyToken(route, scope);
      const proxyCa = p.caBundle ? caList([p.caBundle]) : caList([]);
      return new ProxyAgent({
        uri: p.url,
        ...(token ? { token } : {}),
        requestTls: { ...common, timeout: limits.connectTimeoutMs },
        proxyTls: {
          ...(proxyCa ? { ca: proxyCa } : {}),
          rejectUnauthorized: true,
          timeout: limits.connectTimeoutMs,
          ...(pinProxy(scope) ? { lookup: pinLookup(ctx) } : {}),
        },
        ...timeouts,
      });
    }
    return new Agent({
      connect: {
        ...common,
        timeout: limits.connectTimeoutMs,
        ...(r.pinned ? { lookup: pinLookup(ctx) } : {}),
      },
      ...timeouts,
    });
  };

  const keyOf = (r: ReturnType<typeof resolve>, ctx: OutboundContext) =>
    JSON.stringify([
      r.route.via,
      r.route.proxy?.url,
      // userinfo may sit in the URL: only a digest goes into the key
      r.route.routeName === 'legacy-proxyUrl' && r.scope.proxyUrl ? sha(r.scope.proxyUrl) : null,
      pinProxy(r.scope),
      r.route.ca.bundles,
      r.route.clientCert ?? null,
      r.pinned,
      r.pinned ? (ctx.pin?.allow ?? []) : null,
    ]);

  const plan = (url: string | URL, ctx: OutboundContext): OutboundPlan => {
    const r = resolve(url, ctx);
    const key = keyOf(r, ctx);
    let dispatcher = dispatchers.get(key);
    if (dispatcher) {
      dispatchers.delete(key);
    } else {
      dispatcher = build(r, ctx);
      if (dispatchers.size >= MAX_CACHED_DISPATCHERS) {
        const oldest = dispatchers.keys().next().value;
        if (oldest !== undefined) {
          const evicted = dispatchers.get(oldest);
          dispatchers.delete(oldest);
          // graceful: requests in flight finish, then the sockets close
          void evicted?.close().catch(() => undefined);
        }
      }
    }
    dispatchers.set(key, dispatcher);
    return { route: r.route, audit: r.audit, dispatcher };
  };

  const impl: NonNullable<OutboundOptions['fetchImpl']> =
    opts.fetchImpl ?? ((u, init) => undiciFetch(u, init as never) as unknown as Promise<Response>);

  return {
    get network() {
      return net();
    },
    plan,
    async fetch(url, init, ctx) {
      const { dispatcher, route } = plan(url, ctx);
      // Behind a proxy the proxy resolves the name, so a tenant destination cannot be pinned:
      // resolve it once here and refuse non-public answers (residual: the proxy may resolve
      // differently, see ADR 0011 amendment 3).
      if (route.decision === 'proxy' && ctx.scope?.origin === 'tenant')
        await assertPublicDestination(new URL(String(url)).hostname, {
          allow: [...(ctx.pin?.allow ?? []), ...net().config.privateAllow],
          ...(ctx.pin?.lookup ? { lookup: ctx.pin.lookup } : {}),
        });
      const signals: AbortSignal[] = [];
      if (init?.signal) signals.push(init.signal);
      if (ctx.timeoutMs) signals.push(AbortSignal.timeout(ctx.timeoutMs));
      const res = await impl(String(url), {
        ...init,
        // A redirect would carry the request (and its credentials) to another origin.
        redirect: 'error',
        dispatcher,
        ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      });
      return limitBody(res, limits.maxResponseBytes);
    },
    async dial(target, ctx) {
      const host = target.host.replace(/^\[|\]$/g, '');
      const url = new URL(`https://${host.includes(':') ? `[${host}]` : host}:${target.port}/`);
      const r = resolve(url, ctx);
      const p = r.route.proxy;
      if (!p) {
        return await connectWithin(
          () =>
            netConnect({
              host,
              port: target.port,
              ...(r.pinned ? { lookup: pinLookup(ctx) } : {}),
            }),
          limits.connectTimeoutMs,
        );
      }
      const token = proxyToken(r.route, r.scope);
      const proxyCa = p.caBundle ? caList([p.caBundle]) : caList([]);
      const sock = await connectWithin(
        () =>
          p.scheme === 'https'
            ? tlsConnect({
                host: p.host,
                port: p.port,
                servername: p.host,
                ...(proxyCa ? { ca: proxyCa } : {}),
                rejectUnauthorized: true,
                ...(pinProxy(r.scope) ? { lookup: pinLookup(ctx) } : {}),
              })
            : netConnect({
                host: p.host,
                port: p.port,
                ...(pinProxy(r.scope) ? { lookup: pinLookup(ctx) } : {}),
              }),
        limits.connectTimeoutMs,
      );
      try {
        await proxyConnect(sock, `${url.hostname}:${target.port}`, token, limits.connectTimeoutMs);
      } catch (e) {
        sock.destroy();
        throw e;
      }
      return sock;
    },
    nodeAgents(url, ctx) {
      const r = resolve(url, ctx);
      const p = r.route.proxy;
      const common = targetTls(r.route);
      if (p) {
        const token = proxyToken(r.route, r.scope);
        const proxyCa = p.caBundle ? caList([p.caBundle]) : caList([]);
        // Constructor options are for the PROXY hop only (its trust, no client certificate);
        // destination trust and client certificate go through `targetTls`.
        const agent = new TunnelAgent(
          p.url,
          {
            rejectUnauthorized: true,
            ...(token ? { headers: { 'Proxy-Authorization': token } } : {}),
            ...(proxyCa ? { ca: proxyCa } : {}),
            ...(pinProxy(r.scope) ? { lookup: pinLookup(ctx) } : {}),
          },
          common,
        );
        return { route: r.route, audit: r.audit, httpsAgent: agent, httpAgent: agent };
      }
      const lookup = r.pinned ? { lookup: pinLookup(ctx) } : {};
      return {
        route: r.route,
        audit: r.audit,
        httpsAgent: new HttpsAgent({ ...common, ...lookup }),
        httpAgent: new HttpAgent({ ...lookup }),
      };
    },
    async close() {
      const all = [...dispatchers.values()];
      dispatchers.clear();
      pems.clear();
      await Promise.all(all.map((d) => d.close().catch(() => undefined)));
    },
  };
}

/** Resolves with the socket once it is connected (or secure-connected); rejects on error/timeout. */
function connectWithin(make: () => Socket, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const sock = make();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new OaxError('connect_timeout', 'the connection timed out'));
    }, timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e instanceof OaxError ? e : new OaxError('connect_failed', 'the connection failed'));
    };
    sock.once('error', fail);
    sock.once(
      (sock as { encrypted?: boolean }).encrypted !== undefined || 'getProtocol' in sock
        ? 'secureConnect'
        : 'connect',
      () => {
        clearTimeout(timer);
        sock.off('error', fail);
        resolveSocket(sock);
      },
    );
  });
}

/** HTTP CONNECT handshake on an open proxy socket; leaves the socket positioned after the head. */
function proxyConnect(
  sock: Socket,
  authority: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveDone, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(
      () => done(new OaxError('connect_timeout', 'proxy handshake timed out')),
      timeoutMs,
    );
    const done = (e?: OaxError) => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
      if (e) reject(e);
      else resolveDone();
    };
    const onError = () => done(new OaxError('connect_failed', 'the proxy connection failed'));
    const onClose = onError;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 8192) done(new OaxError('connect_failed', 'the proxy answer is too long'));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'));
      if (!status || status[1] !== '200')
        return done(
          new OaxError(
            'proxy_connect_refused',
            `the proxy refused the tunnel (${status?.[1] ?? '?'})`,
          ),
        );
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) sock.unshift(rest);
      done();
    };
    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);
    sock.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
        token ? `Proxy-Authorization: ${token}\r\n` : ''
      }\r\n`,
    );
  });
}

const shared = new Map<string, OutboundDispatcher>();

/**
 * One factory per process for callers without their own network configuration (the legacy
 * proxy environment), instead of one per client. Keyed by the proxy-relevant environment, so a
 * changed `HTTPS_PROXY` gets a fresh factory.
 */
export function sharedOutboundDispatcher(
  env: Record<string, string | undefined> = process.env,
): OutboundDispatcher {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED'];
  const key = sha(JSON.stringify(names.map((n) => [env[n], env[n.toLowerCase()]])));
  let d = shared.get(key);
  if (!d) {
    if (shared.size >= 8) {
      for (const old of shared.values()) void old.close().catch(() => undefined);
      shared.clear();
    }
    d = createOutboundDispatcher({ env, allowPlainHttpForPlatform: true });
    shared.set(key, d);
  }
  return d;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
