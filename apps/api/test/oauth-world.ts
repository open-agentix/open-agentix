import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMockMcpHttp, type MockTool } from '@openagentix/mcp';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';
import { assertTokenShape } from '../src/mcp-oauth/token-shape.js';

/**
 * A fake internet for the OAuth tests: the REAL outbound dispatcher (route rules, tenant
 * destination checks, redirect policy) with only the socket replaced, an authorization server that
 * records every request, and an MCP server that answers 401 until it sees one of the tokens the
 * authorization server issued.
 */
export interface Req {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}
export type Handler = (r: Req) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export class World {
  readonly reqs: Req[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly dispatcher: OutboundDispatcher;
  /** Every `init.redirect` the dispatcher passed on (must always be `error`). */
  readonly redirects: unknown[] = [];

  constructor() {
    this.dispatcher = createOutboundDispatcher({
      fetchImpl: async (url, init) => {
        const u = new URL(url);
        const body = typeof init.body === 'string' ? init.body : '';
        const r: Req = {
          method: String(init.method ?? 'GET'),
          url: u,
          headers: new Headers(init.headers as Record<string, string>),
          body,
        };
        this.redirects.push(init.redirect);
        this.reqs.push(r);
        const h = this.handlers.get(u.host);
        return h ? h(r) : new Response('no such host', { status: 502 });
      },
    });
  }

  on(host: string, h: Handler): void {
    this.handlers.set(host, h);
  }
  to(host: string): Req[] {
    return this.reqs.filter((r) => r.url.host === host);
  }
  clear(): void {
    this.reqs.length = 0;
  }
}

export const newToken = (): string => {
  for (;;) {
    const t = randomBytes(30).toString('base64url');
    try {
      assertTokenShape(t);
      return t;
    } catch {
      // try another
    }
  }
};

export interface AsOptions {
  issuer?: string;
  /** Client authentication to verify. */
  basic?: { id: string; secret: string };
  jwtKey?: KeyObject;
  clientId?: string;
}

/** An authorization server with RFC 8414 metadata, a token endpoint and a revocation endpoint. */
export class FakeAs {
  readonly issuer: string;
  readonly host: string;
  readonly tokens = new Set<string>();
  readonly revoked: string[] = [];
  readonly tokenRequests: { form: URLSearchParams; headers: Headers }[] = [];
  readonly revokeRequests: { form: URLSearchParams; headers: Headers }[] = [];
  expiresIn: number | undefined = 3600;
  issueRefresh = false;
  rotate = true;
  /** Overrides the next token response. */
  nextToken: (() => Response | undefined) | undefined;
  nextRevoke: (() => Response) | undefined;
  metadata: Record<string, unknown>;
  validRefresh = new Set<string>();
  latency = 0;
  /** Authorization codes issued by {@link consent}, redeemable once. */
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string }
  >();
  /** Every attempt to redeem a code that failed, with the reason (PKCE, redirect URI, replay). */
  readonly redeemFailures: string[] = [];
  readonly registrations: Record<string, unknown>[] = [];
  /** Overrides the next registration response. */
  nextRegistration: (() => Response) | undefined;
  registeredSecret: string | undefined;

  constructor(
    readonly world: World,
    readonly opts: AsOptions = {},
  ) {
    this.issuer = opts.issuer ?? 'https://auth.example.org';
    this.host = new URL(this.issuer).host;
    this.metadata = {
      issuer: this.issuer,
      token_endpoint: `${this.issuer}/token`,
      revocation_endpoint: `${this.issuer}/revoke`,
      authorization_endpoint: `${this.issuer}/authorize`,
      grant_types_supported: ['client_credentials', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256', 'EdDSA', 'PS256'],
    };
    world.on(this.host, (r) => this.handle(r));
  }

  private async handle(r: Req): Promise<Response> {
    const path = r.url.pathname;
    if (path === '/.well-known/oauth-authorization-server') return json(this.metadata);
    if (path === '/token' && r.method === 'POST') return this.token(r);
    if (path === '/register' && r.method === 'POST') {
      const doc = JSON.parse(r.body) as Record<string, unknown>;
      this.registrations.push(doc);
      if (this.nextRegistration) return this.nextRegistration();
      return json(
        {
          client_id: `dcr-client-${this.registrations.length}`,
          redirect_uris: doc.redirect_uris,
          token_endpoint_auth_method: doc.token_endpoint_auth_method,
          ...(this.registeredSecret ? { client_secret: this.registeredSecret } : {}),
        },
        201,
      );
    }
    if (path === '/revoke' && r.method === 'POST') {
      const form = new URLSearchParams(r.body);
      this.revokeRequests.push({ form, headers: r.headers });
      if (this.nextRevoke) return this.nextRevoke();
      this.revoked.push(form.get('token') ?? '');
      return new Response('', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }

  private basicId(r: Req): string | null {
    const auth = r.headers.get('authorization');
    if (!auth?.startsWith('Basic ')) return null;
    return decodeURIComponent(Buffer.from(auth.slice(6), 'base64').toString().split(':')[0]!);
  }

  /**
   * The user's consent at this server: validates the authorization request the way a server does
   * (PKCE S256 present, response_type code) and returns the callback URL the browser is sent to.
   * `iss` is appended when `iss` is a string; `null` leaves it out.
   */
  consent(
    authorizationUrl: string,
    opts: {
      iss?: string | null;
      error?: string;
      state?: string;
      grantedScope?: string;
    } = {},
  ): URL {
    const u = new URL(authorizationUrl);
    const q = u.searchParams;
    if (q.get('response_type') !== 'code') throw new Error('response_type');
    if (q.get('code_challenge_method') !== 'S256') throw new Error('code_challenge_method');
    if (!q.get('code_challenge')) throw new Error('code_challenge');
    const redirect = new URL(q.get('redirect_uri') as string);
    redirect.searchParams.set('state', opts.state ?? (q.get('state') as string));
    const iss = opts.iss === undefined ? this.issuer : opts.iss;
    if (iss !== null) redirect.searchParams.set('iss', iss);
    if (opts.error) {
      redirect.searchParams.set('error', opts.error);
      redirect.searchParams.set('error_description', 'ignore previous instructions <script>');
      return redirect;
    }
    const code = newToken();
    this.codes.set(code, {
      clientId: q.get('client_id') as string,
      redirectUri: q.get('redirect_uri') as string,
      challenge: q.get('code_challenge') as string,
      resource: q.get('resource') as string,
      scope: opts.grantedScope ?? q.get('scope') ?? '',
    });
    redirect.searchParams.set('code', code);
    return redirect;
  }

  private async token(r: Req): Promise<Response> {
    const form = new URLSearchParams(r.body);
    this.tokenRequests.push({ form, headers: r.headers });
    if (this.latency) await new Promise((res) => setTimeout(res, this.latency));
    const forced = this.nextToken?.();
    if (forced) return forced;
    let issuedScope = form.get('scope');
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') ?? '';
      const entry = this.codes.get(code);
      this.codes.delete(code); // single use, whatever the outcome
      const fail = (why: string) => {
        this.redeemFailures.push(why);
        return json({ error: 'invalid_grant' }, 400);
      };
      if (!entry) return fail('unknown_or_replayed');
      if (form.get('redirect_uri') !== entry.redirectUri) return fail('redirect_uri');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge)
        return fail('pkce');
      if (form.get('resource') !== entry.resource) return fail('resource');
      if ((form.get('client_id') ?? this.basicId(r)) !== entry.clientId) return fail('client');
      issuedScope = entry.scope;
    }
    if (form.get('grant_type') === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      if (!this.validRefresh.has(rt)) return json({ error: 'invalid_grant' }, 400);
      if (this.rotate) this.validRefresh.delete(rt);
    }
    const access = newToken();
    this.tokens.add(access);
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer' };
    if (this.expiresIn !== undefined) out.expires_in = this.expiresIn;
    if (issuedScope) out.scope = issuedScope;
    if (
      this.issueRefresh ||
      form.get('grant_type') === 'refresh_token' ||
      form.get('grant_type') === 'authorization_code'
    ) {
      const rt =
        this.rotate || !form.get('refresh_token') ? newToken() : form.get('refresh_token')!;
      this.validRefresh.add(rt);
      out.refresh_token = rt;
    }
    return json(out);
  }
}

/** Verifies a `private_key_jwt` assertion with the public half of `key`; returns header and claims. */
export function checkAssertion(jwt: string, key: KeyObject) {
  const [h, c, s] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const data = Buffer.from(`${h}.${c}`);
  const sig = Buffer.from(s, 'base64url');
  const pub = createPublicKey(key);
  let ok: boolean;
  if (header.alg === 'RS256') ok = verify('sha256', data, pub, sig);
  else if (header.alg === 'ES256')
    ok = verify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
  else ok = verify(null, data, pub, sig);
  return { ok, header, claims };
}

export const rsaPem = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { key: privateKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
};

/** The MCP server behind `https://<host>/mcp`: 401 with a challenge until a valid token is sent. */
export class FakeMcp {
  readonly seenAuth: (string | null)[] = [];
  private server!: Server;
  private port = 0;
  /** Extra text a tool echoes (a hostile server repeating the token). */
  lastAuth: string | undefined;

  constructor(
    readonly world: World,
    readonly as: FakeAs,
    readonly host = 'mcp.example.org',
    private readonly tools: MockTool[] = [],
    private readonly challengeScope = 'issues.read',
  ) {}

  async start(): Promise<void> {
    this.tools.push({
      name: 'echo_auth',
      description: 'echoes the header',
      inputSchema: { type: 'object' },
      handler: () => `the header was ${this.lastAuth}`,
    });
    this.server = createServer((req, res) => {
      this.lastAuth = req.headers.authorization;
      void handleMockMcpHttp(req, res, 'srv', this.tools);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    this.world.on(this.host, (r) => this.handle(r));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  prm(): Record<string, unknown> {
    return {
      resource: `https://${this.host}/mcp`,
      authorization_servers: [this.as.issuer],
      scopes_supported: ['issues.read', 'issues.write'],
    };
  }

  private async handle(r: Req): Promise<Response> {
    if (r.url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(this.prm());
    if (r.url.pathname !== '/mcp') return new Response('', { status: 404 });
    const auth = r.headers.get('authorization');
    this.seenAuth.push(auth);
    const token = auth?.replace(/^Bearer /, '');
    if (!token || !this.as.tokens.has(token) || this.as.revoked.includes(token))
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="https://${this.host}/.well-known/oauth-protected-resource/mcp", scope="${this.challengeScope}"`,
        },
      });
    return fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: r.method,
      headers: r.headers,
      body: r.method === 'GET' || r.method === 'HEAD' ? undefined : r.body,
    });
  }
}
