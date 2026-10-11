import { CLASSIFICATIONS, TOOL_ACCESS } from '@openagentix/core';
import { z } from 'zod';

/** An OAuth scope token (RFC 6749 section 3.3): printable ASCII without space, quote and backslash. */
export const OAUTH_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const scopeToken = z.string().regex(OAUTH_SCOPE, 'invalid OAuth scope');

/**
 * Access class of one tool: `write` is the default for every tool that is not declared. `scopes`
 * are the OAuth scopes the tool needs (ADR 0016 section 7.7); a connection with
 * `auth.scopes: "from-profiles"` requests the union over the tools its profiles contain.
 */
export const McpToolAccessSchema = z.strictObject({
  access: z.enum(TOOL_ACCESS),
  scopes: z.array(scopeToken).max(16).optional(),
});
export type McpToolAccess = z.infer<typeof McpToolAccessSchema>;

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'invalid tool name (no wildcards)');
const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'profile names are lowercase slugs');
const MAX_TOOLS = 500;

/**
 * Telemetry settings of an MCP instance (ADR 0015 section 6.4). `propagate` is off unless set: the
 * run's `traceparent` is then sent in `params._meta` of `tools/call`, and only if the platform allows
 * it too (`OAX_OTEL_MCP_PROPAGATION=allow`). Strict: there is nothing else to configure, so no header
 * name, `tracestate` or `baggage` can be supplied here.
 */
export const McpTelemetrySchema = z.strictObject({ propagate: z.boolean().default(false) });
export type McpTelemetry = z.infer<typeof McpTelemetrySchema>;

/** Declared tool classes and named profiles (ADR 0008); shared by every transport. */
const accessFields = {
  /** Declared access class per tool (`{ get_issue: { access: read } }`). */
  tools: z.record(toolName, McpToolAccessSchema).default({}),
  /** Profile name -> tools; every member must be declared in `tools`. */
  profiles: z.record(profileName, z.array(toolName).min(1).max(MAX_TOOLS)).default({}),
  /** Opt-in trace context propagation; absent means off. */
  telemetry: McpTelemetrySchema.optional(),
};

const secretRef = z.string().min(1).max(128);

/**
 * How a streamable-HTTP connection authenticates (ADR 0016 section 7.1). `static` is the
 * `headerSecrets` of earlier versions and the meaning of an absent `auth`; `none` sends no
 * credential; `oauth` obtains audience-bound access tokens (OAuth 2.1 per the MCP authorization
 * specification). `client_credentials` uses a pre-registered client, `authorization_code` any of the
 * three registrations; the client id, the client secret and the private key are secret references,
 * never values.
 */
export const McpOauthAuthSchema = z
  .strictObject({
    kind: z.literal('oauth'),
    /**
     * `client_credentials`: service connections, nobody present (pre-registered client only).
     * `authorization_code`: an administrator consents once per connection instance (PKCE S256).
     */
    grant: z.enum(['client_credentials', 'authorization_code']),
    client: z.strictObject({
      /**
       * `preregistered`: the client exists at the authorization server and is referenced by
       * secret references. `cimd` (authorization_code only): the platform's Client ID Metadata
       * Document is the client id. `dcr` (authorization_code only): dynamic registration, one
       * client per tenant and authorization server. Both are off unless the operator enables them.
       */
      registration: z.enum(['preregistered', 'cimd', 'dcr']).default('preregistered'),
      /** Required for `preregistered`; the client id of `cimd` and `dcr` is not configuration. */
      clientIdSecret: secretRef.optional(),
      /** Required for `preregistered`; `none` (public client) only with `authorization_code`. */
      clientAuth: z.enum(['private_key_jwt', 'client_secret_basic', 'none']).optional(),
      /** `private_key_jwt`: the PEM private key (RSA, P-256 or Ed25519). */
      keySecret: secretRef.optional(),
      /** `kid` header of the client assertion, when the authorization server needs one. */
      keyId: z
        .string()
        .regex(/^[\x21-\x7e]{1,128}$/)
        .optional(),
      /** `client_secret_basic`: the client secret. */
      clientSecretSecret: secretRef.optional(),
    }),
    /** `from-profiles`: derived from the tools of the connection's profiles (section 7.7). */
    scopes: z
      .union([z.literal('from-profiles'), z.array(scopeToken).max(32)])
      .default('from-profiles'),
    /** Optional pin of the authorization server; filled at the first authorization otherwise. */
    issuer: z.string().url().max(2048).optional(),
  })
  .superRefine((a, ctx) => {
    const c = a.client;
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: ['client', path], message });
    if (a.grant === 'client_credentials' && c.registration !== 'preregistered')
      bad('registration', 'client_credentials needs a preregistered client');
    if (c.registration === 'preregistered') {
      if (!c.clientIdSecret) bad('clientIdSecret', 'a preregistered client needs clientIdSecret');
      if (!c.clientAuth) bad('clientAuth', 'a preregistered client needs clientAuth');
      if (c.clientAuth === 'none' && a.grant === 'client_credentials')
        bad('clientAuth', 'client_credentials needs a confidential client');
      if (c.clientAuth) {
        const need =
          c.clientAuth === 'private_key_jwt'
            ? 'keySecret'
            : c.clientAuth === 'client_secret_basic'
              ? 'clientSecretSecret'
              : null;
        for (const field of ['keySecret', 'clientSecretSecret'] as const) {
          if (field === need && !c[field]) bad(field, `${c.clientAuth} needs ${field}`);
          if (field !== need && c[field]) bad(field, `${c.clientAuth} does not use ${field}`);
        }
      }
    } else {
      // The client id is the metadata document (cimd) or the registration result (dcr): nothing
      // about the client is configured, and no secret reference can be steered to a server.
      for (const field of ['clientIdSecret', 'keySecret', 'clientSecretSecret', 'keyId'] as const)
        if (c[field]) bad(field, `${c.registration} does not use ${field}`);
      if (c.clientAuth && c.clientAuth !== 'none')
        bad('clientAuth', `${c.registration} registers a public client`);
    }
    // A shared secret goes to whatever token endpoint the MCP server's metadata names; only an
    // operator-pinned issuer keeps a hostile or hijacked server from collecting it.
    if (c.clientAuth === 'client_secret_basic' && !a.issuer)
      ctx.addIssue({
        code: 'custom',
        path: ['issuer'],
        message: 'client_secret_basic needs auth.issuer (the secret is sent to the token endpoint)',
      });
    if (c.keyId && c.clientAuth !== 'private_key_jwt' && c.registration === 'preregistered')
      bad('keyId', 'keyId needs private_key_jwt');
    if (a.issuer) {
      let u: URL | undefined;
      try {
        u = new URL(a.issuer);
      } catch {
        // reported by the url check above
      }
      if (u && (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search))
        ctx.addIssue({
          code: 'custom',
          path: ['issuer'],
          message: 'the issuer must be an https URL without credentials, query or fragment',
        });
    }
  });
export type McpOauthAuth = z.infer<typeof McpOauthAuthSchema>;

/** How the client authenticates at the token endpoint; `cimd` and `dcr` clients are public by default. */
export const clientAuthOf = (
  c: McpOauthAuth['client'],
): 'private_key_jwt' | 'client_secret_basic' | 'none' => c.clientAuth ?? 'none';

export const McpAuthSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('static') }),
  McpOauthAuthSchema,
]);
export type McpAuth = z.infer<typeof McpAuthSchema>;

/** The authentication kind of an HTTP connection; an absent `auth` is `static` (earlier versions). */
export const authKindOf = (cfg: {
  auth?: { kind: string } | undefined;
}): 'none' | 'static' | 'oauth' =>
  (cfg.auth?.kind as 'none' | 'static' | 'oauth' | undefined) ?? 'static';

/** An MCP server connection (stored as a "connection" in the control node). */
/**
 * Profile rules: members must be declared tools (unknown tools are refused when the connection is
 * saved), no duplicates, and a profile named `read` may only hold `read` tools.
 */
export function profileIssues(cfg: {
  tools: Record<string, McpToolAccess>;
  profiles: Record<string, string[]>;
}): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (Object.keys(cfg.tools).length > MAX_TOOLS)
    issues.push({ path: ['tools'], message: `more than ${MAX_TOOLS} declared tools` });
  for (const [name, members] of Object.entries(cfg.profiles)) {
    const seen = new Set<string>();
    members.forEach((tool, i) => {
      const path = ['profiles', name, i];
      if (!Object.hasOwn(cfg.tools, tool))
        issues.push({ path, message: `profile "${name}" lists unknown tool "${tool}"` });
      else if (name === 'read' && cfg.tools[tool]!.access !== 'read')
        issues.push({ path, message: `profile "read" must not contain write tool "${tool}"` });
      if (seen.has(tool)) issues.push({ path, message: `duplicate tool "${tool}" in "${name}"` });
      seen.add(tool);
    });
  }
  return issues;
}

export const McpServerConfigSchema = z
  .discriminatedUnion('transport', [
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      transport: z.literal('stdio'),
      /** Executable inside the worker/toolbox image (pinned binary, never `npx <latest>`). */
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      /** Plain environment variables. */
      env: z.record(z.string(), z.string()).default({}),
      /** Environment variable name -> secret reference. */
      envSecrets: z.record(z.string(), z.string()).default({}),
      /**
       * Hosts this server itself needs (ADR 0016 section 4.1), in the grammar of `runtime.egress`.
       * Empty or absent means NO network: the child gets no proxy variables. The container runner
       * mints one egress grant per (node, connection) from it; it is bounded by the operator's
       * per-program grant (`OAX_MCP_STDIO_EGRESS`, tenants), the runner ceiling and the air-gapped
       * allowlist. Checked by the API when saved and again by the control node before each step.
       */
      egress: z.array(z.string().min(1).max(255)).max(16).optional(),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      transport: z.literal('streamable-http'),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).default({}),
      /** Header name -> secret reference (e.g. `authorization`). */
      headerSecrets: z.record(z.string(), z.string()).default({}),
      /**
       * Authentication of the connection (ADR 0016 section 7.1). Absent means `static`: the
       * credentials are the `headerSecrets`. `oauth` together with an `authorization` header is
       * refused (`auth_conflict`).
       */
      auth: McpAuthSchema.optional(),
      /**
       * Hosts the server needs. An HTTP server is contacted at its `url` only, so this may list
       * the host of the url and nothing else (ADR 0016 section 4.1); `checkHttpConfig` enforces it.
       */
      egress: z.array(z.string().min(1).max(255)).max(16).optional(),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      /** In-process server registered by the host (tests, demo, built-in tools). */
      transport: z.literal('in-memory'),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
  ])
  .superRefine((cfg, ctx) => {
    for (const issue of profileIssues(cfg)) ctx.addIssue({ code: 'custom', ...issue });
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;

/** `server/tool` -> class for every declared tool of the given connections (policy gate input). */
export function toolAccessOfConfigs(
  configs: readonly Pick<McpServerConfig, 'name' | 'tools'>[],
): Record<string, 'read' | 'write'> {
  const out: Record<string, 'read' | 'write'> = {};
  for (const c of configs)
    for (const [tool, v] of Object.entries(c.tools)) out[`${c.name}/${tool}`] = v.access;
  return out;
}
