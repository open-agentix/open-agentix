/**
 * Post-processing of the generated OpenAPI document: standard error responses, non-JSON media
 * types (SSE, NDJSON, Prometheus) and redirects that the zod schemas cannot express.
 */
type Doc = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
};
type Operation = {
  security?: Record<string, unknown>[];
  responses?: Record<string, unknown>;
  [k: string]: unknown;
};

const ERROR_REF = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ERROR_REF } },
});

const MEDIA: Record<
  string,
  { status: string; type: string; description: string; schema: unknown }
> = {
  'get /v1/runs/{id}/stream': {
    status: '200',
    type: 'text/event-stream',
    description: 'Server-Sent Events: `step` (id = step seq), `status`, `end`',
    schema: { type: 'string' },
  },
  'get /v1/audit/export': {
    status: '200',
    type: 'application/x-ndjson',
    description: 'One audit entry (JSON) per line, oldest first',
    schema: { type: 'string' },
  },
  'get /v1/costs/export': {
    status: '200',
    type: 'text/csv',
    description: 'CSV (or JSON with `format=json`) cost lines',
    schema: { type: 'string' },
  },
  'get /metrics': {
    status: '200',
    type: 'text/plain',
    description: 'Prometheus exposition format',
    schema: { type: 'string' },
  },
};

/** Operations whose 200 answer is JSON or, on `Accept: text/event-stream`, Server-Sent Events. */
const ALSO_SSE: Record<string, string> = {
  'post /v1/worker/runs/{id}/model':
    'Server-Sent Events: `start` (`callId`), `delta` (`text`), then `done` (the `WorkerModelResponse`) or `error` (`code`, `message`)',
};

/** Model proxy operations never answer 404: an unknown or foreign run is a 403. */
const NO_NOT_FOUND = new Set([
  'post /v1/worker/runs/{id}/model',
  'post /v1/worker/runs/{id}/model-token',
  'post /v1/worker/runs/{id}/model-reservations',
]);

/** Error body of the pass-through surfaces: Anthropic `{ type, error }` or OpenAI `{ error }`. */
const PROTOCOL_ERROR = {
  type: 'object',
  description:
    'Anthropic: `{ "type": "error", "error": { "type", "message", "code" } }`; OpenAI: `{ "error": { "message", "type", "code" } }`. `code` is the platform code of ADR 0009 section 2.5.',
};
const PROTOCOL_ERRORS: Record<string, string> = {
  '400':
    'Request refused: `model_request_invalid`, `model_parameter_refused`, `model_surface_mismatch`',
  '401': 'Missing, malformed or expired model token (a run token is not accepted)',
  '403':
    'Not allowed: model, session, classification, egress, security override or budget (`control_budget_*`)',
  '413': 'Request body over `OAX_MODEL_PROXY_MAX_BODY_BYTES`',
  '422': '`model_unpriced`: a cost limit applies and the model has no price',
  '429': 'Rate or concurrency limit; `Retry-After` is set',
  '502': 'Upstream provider error',
  '503': 'Model proxy disabled or settlement unavailable',
  '504': 'Upstream exceeded the call deadline',
};

const REDIRECTS: Record<string, string> = {
  'get /v1/auth/oidc/login': 'Redirect to the identity provider (authorization code + PKCE)',
  'get /v1/auth/oidc/callback':
    'Redirect to `<OAX_UI_URL>/auth/callback#token=…&expiresAt=…` (or 200 JSON without a UI URL)',
};

export function decorateOpenApi<T>(input: T): T {
  const doc = input as unknown as Doc;
  doc.components ??= {};
  doc.components.schemas = {
    ...(doc.components.schemas ?? {}),
    McpToolAccess: {
      type: 'object',
      required: ['access'],
      additionalProperties: false,
      properties: { access: { type: 'string', enum: ['read', 'write'] } },
    },
    McpConnectionAccess: {
      type: 'object',
      description:
        'Tool classes and named profiles inside the config of an `mcp` connection (alongside transport, url, ...). A tool that is not declared counts as `write`; profile members must be declared tools; a profile named `read` may only hold read tools.',
      properties: {
        tools: {
          type: 'object',
          additionalProperties: { $ref: '#/components/schemas/McpToolAccess' },
        },
        profiles: {
          type: 'object',
          description: 'profile name (slug) -> declared tool names',
          additionalProperties: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        telemetry: {
          type: 'object',
          description:
            "Opt-in trace context propagation (ADR 0015 section 6.4). With `propagate: true` (and `OAX_OTEL_MCP_PROPAGATION=allow` on the platform) the run's `traceparent` is sent in `params._meta` of `tools/call`; never `tracestate` or `baggage`. Enabling it needs a tenant admin (platform operator for platform connections).",
          additionalProperties: false,
          properties: { propagate: { type: 'boolean', default: false } },
        },
      },
    },
    Error: {
      type: 'object',
      required: ['error', 'message'],
      properties: {
        error: { type: 'string', description: 'stable error code' },
        message: { type: 'string' },
        details: {},
      },
    },
  };
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      const key = `${method} ${path}`;
      op.responses ??= {};
      const security = (op.security ?? []).flatMap((s) => Object.keys(s));
      if (security.length > 0) {
        op.responses['401'] ??= errorResponse('Missing or invalid credentials');
        op.responses['403'] ??= errorResponse('Insufficient permissions');
      }
      if (path.includes('{') && !NO_NOT_FOUND.has(key))
        op.responses['404'] ??= errorResponse('Not found');
      if (path.startsWith('/v1/model-proxy/')) {
        // Pass-through surfaces answer in the protocol's own shapes and error envelopes.
        const envelope = {
          content: { 'application/json': { schema: PROTOCOL_ERROR } },
        };
        op.responses['200'] = {
          description:
            method === 'post'
              ? 'The protocol response (JSON), or Server-Sent Events of the protocol with `stream: true`; `x-oax-call-id` (and `x-oax-cost-micros` for JSON) identify the metered call'
              : "The protocol model list (exactly the model of the token's step)",
          content: {
            'application/json': { schema: { type: 'object' } },
            ...(method === 'post' ? { 'text/event-stream': { schema: { type: 'string' } } } : {}),
          },
        };
        for (const [status, description] of Object.entries(PROTOCOL_ERRORS))
          op.responses[status] = { description, ...envelope };
      }
      const sse = ALSO_SSE[key];
      const ok = op.responses['200'] as { content?: Record<string, unknown> } | undefined;
      if (sse && ok)
        ok.content = { ...ok.content, 'text/event-stream': { schema: { type: 'string' } } };
      const media = MEDIA[key];
      if (media)
        op.responses[media.status] = {
          description: media.description,
          content: { [media.type]: { schema: media.schema } },
        };
      const redirect = REDIRECTS[key];
      if (redirect) {
        op.responses['302'] = {
          description: redirect,
          headers: { Location: { schema: { type: 'string' } } },
        };
        if (key.endsWith('/login')) delete op.responses['200'];
      }
    }
  }
  return input;
}
