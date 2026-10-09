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
