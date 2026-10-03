import { http, HttpResponse } from 'msw';
import type { ResponseOf } from '../src/api/types';
import * as f from './fixtures';

/** All handlers answer with fixtures typed against the generated OpenAPI types. */
export const api = (path: string) => `${window.location.origin}${path}`;

const json = <T>(body: T, status = 200) => HttpResponse.json(body as never, { status });

export const handlers = [
  http.get(api('/v1/version'), () =>
    json<ResponseOf<'/v1/version', 'get'>>({ name: 'openagentix', version: '0.1.0' }),
  ),
  http.get(api('/v1/me'), () => json(f.meAdmin)),
  http.get(api('/v1/settings'), () => json(f.settings)),
  http.post(api('/v1/auth/logout'), () => new HttpResponse(null, { status: 200 })),
  http.get(api('/v1/agents'), () =>
    json<ResponseOf<'/v1/agents', 'get'>>({ items: [f.agent, f.draftOnlyAgent], nextCursor: null }),
  ),
  http.get(api('/v1/agents/:id'), ({ params }) =>
    params.id === f.ids.agent2
      ? json(f.draftOnlyAgent)
      : params.id === f.ids.agent
        ? json(f.agent)
        : json({ error: 'not_found', message: 'agent not found' }, 404),
  ),
  http.get(api('/v1/agents/:id/versions'), ({ params }) =>
    json({ items: params.id === f.ids.agent ? f.versions : [] }),
  ),
  http.get(api('/v1/agents/:id/versions/:version'), ({ params }) =>
    json({
      ...f.versionDetail,
      version: String(params.version),
      source:
        params.version === '0.9.0'
          ? f.publishedSource.replace('1.0.0', '0.9.0')
          : f.publishedSource,
    }),
  ),
  http.post(api('/v1/agents/validate'), async ({ request }) => {
    const { source } = (await request.json()) as { source: string };
    const valid = !source.includes('INVALID');
    return json<ResponseOf<'/v1/agents/validate', 'post'>>({
      valid,
      errors: valid ? [] : [{ path: '/agents/0/model', message: 'Required' }],
      warnings: source.includes('WARN') ? [{ path: '/budget', message: 'no budget' }] : [],
      name: 'ticket-updater',
      version: /version: ([\d.]+)/.exec(source)?.[1] ?? null,
      digest: 'sha256:abc',
    });
  }),
  http.post(api('/v1/agents'), async ({ request }) => {
    const { source } = (await request.json()) as { source: string };
    return json(
      { ...f.draftOnlyAgent, name: /name: ([\w-]+)/.exec(source)?.[1] ?? 'x', draftSource: source },
      201,
    );
  }),
  http.put(api('/v1/agents/:id/draft'), async ({ request }) => {
    const { source } = (await request.json()) as { source: string };
    return json({ ...f.agent, draftSource: source });
  }),
  http.post(api('/v1/agents/:id/publish'), () =>
    json<ResponseOf<'/v1/agents/{id}/publish', 'post', 201>>(
      { version: { ...f.versions[1]!, version: '1.1.0' }, created: true },
      201,
    ),
  ),
  http.post(api('/v1/agents/:id/runs'), () => json(f.run, 202)),
  http.get(api('/v1/runs'), () => json({ items: [f.run, f.finishedRun], nextCursor: null })),
  http.get(api('/v1/runs/:id'), ({ params }) =>
    json(params.id === f.ids.run2 ? f.finishedRun : f.run),
  ),
  http.get(api('/v1/runs/:id/steps'), () => json({ items: f.steps, nextCursor: null })),
  http.get(
    api('/v1/runs/:id/stream'),
    () =>
      new HttpResponse(`event: status\ndata: {"status":"awaiting_approval"}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
  ),
  http.post(api('/v1/runs/:id/cancel'), () => json({ ...f.run, status: 'cancelled' })),
  http.get(api('/v1/approvals'), () => json({ items: [f.approval], nextCursor: null })),
  http.post(api('/v1/approvals/:id/decision'), async ({ request }) => {
    const { decision } = (await request.json()) as { decision: string };
    return json({ ...f.approval, status: decision === 'approve' ? 'approved' : 'rejected' });
  }),
  http.get(api('/v1/costs/summary'), ({ request }) => {
    const groupBy = new URL(request.url).searchParams.get('groupBy') ?? 'agent';
    const key =
      groupBy === 'agent'
        ? f.ids.agent
        : groupBy === 'team'
          ? f.ids.team
          : groupBy === 'run'
            ? f.ids.run
            : 'sim-1';
    return json({
      groupBy,
      items: [
        { key, tokensIn: 1000, tokensOut: 500, costMicros: 9_000_000, costUsd: 9 },
        { key: null, tokensIn: 10, tokensOut: 5, costMicros: 1000, costUsd: 0.001 },
      ],
    });
  }),
  http.get(api('/v1/event-sources'), () => json({ items: f.sources })),
  http.post(api('/v1/event-sources'), async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return json({ ...f.sources[0]!, name: body.name }, 201);
  }),
  http.patch(api('/v1/event-sources/:id'), async ({ request }) => {
    const body = (await request.json()) as { enabled: boolean };
    return json({ ...f.sources[0]!, ...body });
  }),
  http.get(api('/v1/events'), () => json({ items: f.events, nextCursor: null })),
  http.get(api('/v1/connections'), () => json({ items: f.connections })),
  http.post(api('/v1/connections'), async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return json({ ...f.connections[0]!, name: body.name }, 201);
  }),
  http.put(api('/v1/connections/:id'), () => json(f.connections[0])),
  http.delete(api('/v1/connections/:id'), () => new HttpResponse(null, { status: 200 })),
  http.get(api('/v1/policies'), () => json({ items: f.policies })),
  http.post(api('/v1/policies'), async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return json({ ...f.policies[0]!, name: body.name }, 201);
  }),
  http.put(api('/v1/policies/:id'), async ({ request }) =>
    json({ ...f.policies[0]!, ...((await request.json()) as object) }),
  ),
  http.post(api('/v1/policies/evaluate'), () =>
    json({
      effect: 'deny',
      reasons: [{ code: 'tool_forbidden', message: 'tickets/delete_ticket is forbidden' }],
    }),
  ),
  http.get(api('/v1/audit'), () => json({ items: f.auditEntries, nextCursor: null })),
  http.post(api('/v1/audit/verify'), () =>
    json<ResponseOf<'/v1/audit/verify', 'post'>>({
      valid: true,
      checkedEntries: 3,
      checkedCheckpoints: 1,
      headSeq: 3,
      headHash: 'hash0abcdefabcdef',
      issues: [],
    }),
  ),
  http.get(
    api('/v1/audit/export'),
    () => new HttpResponse('{"seq":1}\n', { headers: { 'content-type': 'application/x-ndjson' } }),
  ),
  http.get(api('/v1/audit/checkpoints'), () =>
    json({
      items: [
        {
          seq: 2,
          hash: 'hash1abcdefabcdefabcd',
          ts: new Date().toISOString(),
          keyId: 'k1',
          signature: 'sig',
        },
      ],
    }),
  ),
  http.get(api('/v1/users'), () => json({ items: f.users })),
  http.post(api('/v1/users'), async ({ request }) => {
    const body = (await request.json()) as { displayName: string };
    return json({ ...f.adminUser, displayName: body.displayName }, 201);
  }),
  http.patch(api('/v1/users/:id'), async ({ request }) =>
    json({ ...f.adminUser, ...((await request.json()) as object) }),
  ),
  http.get(api('/v1/teams'), () => json({ items: f.teams })),
  http.post(api('/v1/teams'), async ({ request }) =>
    json({ ...f.teams[0]!, ...((await request.json()) as object) }, 201),
  ),
  http.put(api('/v1/teams/:id/members'), () => new HttpResponse(null, { status: 200 })),
  http.get(api('/v1/tokens'), () => json({ items: f.tokens })),
  http.post(api('/v1/tokens'), async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return json({ ...f.tokens[0]!, name: body.name, token: 'oax_secret_token_value_123' }, 201);
  }),
  http.delete(api('/v1/tokens/:id'), () => new HttpResponse(null, { status: 200 })),
];
