import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantRoleBindings } from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres } from './db-targets.js';
import { buildWorld, type World } from './use-case-world.js';

/**
 * ADR 0017 S2 on the resolver read path: use-case bindings never carry `agents:review` (the same
 * fail-closed decision as for `agents:approve`), the pentest role stays read-only, a platform
 * operator comments in a sub-tenant, and organisations stay isolated.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let w: World;
let reviewId = '';
const j = (res: { json: () => unknown }) => res.json() as Json;

beforeAll(async () => {
  const target = PG_URL ? await openPostgres() : await openPglite();
  w = await buildWorld(target, { OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on' });
  for (const k of ['maint-root', 'maint-uc', 'pt']) await w.mkUser(k, 'org-a');
  await w.bind('maint-root', 'org-a', 'agent-maintainer', { inherit: true });
  await w.bind('maint-uc', 'org-a', 'agent-maintainer', { useCase: 'sec' });
  await w.n.ctx.db.insert(tenantRoleBindings).values({
    id: randomUUID(),
    userId: w.uid['pt']!,
    tenantId: w.id['org-a']!,
    role: 'pentest',
    inherit: false,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    source: 'grant',
  });
  for (const k of ['maint-root', 'maint-uc', 'pt']) await w.relogin(k);
  const edit = await w.req('root-admin', 'PUT', `/v1/agents/${w.agent['a-sec']}/draft`, {
    source: agentSource('a-sec', 'nobody', '1.0.1', 'labels:\n  useCase: sec'),
  });
  expect(edit.statusCode, edit.body).toBe(200);
  const opened = await w.req('root-admin', 'POST', `/v1/agents/${w.agent['a-sec']}/reviews`);
  expect(opened.statusCode, opened.body).toBe(201);
  reviewId = j(opened).id;
}, 240_000);
afterAll(async () => w?.close());

const threads = () => `/v1/reviews/${reviewId}/threads`;

describe('review threads on the resolver path', () => {
  it('never lets a use-case binding comment: agents:review is not a use-case permission', async () => {
    const res = await w.req('maint-uc', 'POST', threads(), { body: 'hello' });
    expect(res.statusCode).toBe(403);
    expect((await w.req('maint-uc', 'GET', threads())).statusCode).toBe(403);
    // reading the review and its changes stays possible through the use case
    expect((await w.req('maint-uc', 'GET', `/v1/reviews/${reviewId}`)).statusCode).toBe(200);
    expect((await w.req('maint-uc', 'GET', `/v1/reviews/${reviewId}/changes`)).statusCode).toBe(
      200,
    );
    // a node-wide maintainer comments
    expect((await w.req('maint-root', 'POST', threads(), { body: 'hello' })).statusCode).toBe(201);
  });

  it('keeps the pentest role read-only: no threads, but the changes may be read', async () => {
    expect((await w.req('pt', 'GET', threads())).statusCode).toBe(403);
    expect((await w.req('pt', 'POST', threads(), { body: 'x' })).statusCode).toBe(403);
    expect((await w.req('pt', 'GET', `/v1/reviews/${reviewId}/changes`)).statusCode).toBe(200);
    expect((await w.req('pt', 'GET', '/v1/me/reviews')).statusCode).toBe(200);
  });

  it('lets a platform operator comment in a sub-tenant', async () => {
    const edit = await w.req(
      'root-admin',
      'PUT',
      `/v1/agents/${w.agent['a-u2']}/draft`,
      {
        source: agentSource('a-u2', 'nobody', '1.0.1', 'labels:\n  useCase: sec'),
      },
      'unit-2',
    );
    expect(edit.statusCode, edit.body).toBe(200);
    const opened = j(
      await w.req(
        'root-admin',
        'POST',
        `/v1/agents/${w.agent['a-u2']}/reviews`,
        undefined,
        'unit-2',
      ),
    );
    const res = await w.n.req({
      method: 'POST',
      url: `/v1/reviews/${opened.id}/threads`,
      headers: { 'x-oax-tenant': w.id['unit-2']! },
      payload: { body: 'from the operator' },
    });
    expect(res.statusCode, res.body).toBe(201);
    // and the review is not reachable from another organisation or from the wrong acting node
    expect((await w.req('b-admin', 'GET', `/v1/reviews/${opened.id}/threads`)).statusCode).toBe(
      404,
    );
  });

  it('isolates organisations: org-b cannot see a thread of org-a', async () => {
    const res = await w.req('b-admin', 'GET', threads());
    expect(res.statusCode).toBe(404);
    expect((await w.req('b-admin', 'POST', threads(), { body: 'x' })).statusCode).toBe(404);
    expect((await w.req('b-admin', 'GET', `/v1/reviews/${reviewId}/changes`)).statusCode).toBe(404);
  });
});
