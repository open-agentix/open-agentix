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
  'get /metrics': {
    status: '200',
    type: 'text/plain',
    description: 'Prometheus exposition format',
    schema: { type: 'string' },
  },
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
      if (path.includes('{')) op.responses['404'] ??= errorResponse('Not found');
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
