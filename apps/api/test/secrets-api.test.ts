import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, secretVersions, secrets } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * The secrets API (ADR 0017 section 13, slice S4): create, rotate, revoke, delete and metadata;
 * scopes and who may manage them; inheritance of metadata; shadowing rules; the import helper. A
 * value is never returned (canary values are searched in every response, the audit log and the
 * database).
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (res: { json: () => unknown }) => res.json() as Json;

const CANARY = (tag: string) => `canary-${tag}-${randomBytes(6).toString('hex')}`;
const canaries: string[] = [];
const canary = (tag: string) => {
  const c = CANARY(tag);
  canaries.push(c);
  return c;
};

let n: TestNode;
const node: Record<string, string> = {};
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
let team: string;
let otherTeam: string;

async function mkTenant(slug: string, parentId?: string) {
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug,
      name: slug,
      ...(parentId ? { parentId } : {}),
      admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  node[slug] = j(r).id;
  tok[slug] = await n.login(`admin@${slug}.example.org`, PW);
}

async function mkUser(key: string, globalRoles: string[]) {
  const res = await n.req({
    method: 'POST',
    url: '/v1/users',
    token: tok['sec-root']!,
    payload: { email: `${key}@sec.example.org`, displayName: key, password: PW, globalRoles },
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@sec.example.org`, PW);
}

const api = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Json,
) => n.req({ method, url, token, ...(payload ? { payload } : {}) });
const create = (token: string, body: Json) => api(token, 'POST', '/v1/secrets', body);
const list = (token: string, query = 'scope=tenant') => api(token, 'GET', `/v1/secrets?${query}`);

beforeAll(async () => {
  n = await testNode(
    {
      OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
      OAX_RATE_LIMIT_LOGIN_MAX: '1000',
      OAX_PROVIDERS: JSON.stringify([
        { kind: 'simulated', name: 'simulated' },
        { kind: 'openai', name: 'oai', apiKeySecret: 'oai-key' },
      ]),
    },
    {},
  );
  await mkTenant('sec-root');
  await mkTenant('sec-child', node['sec-root']);
  await mkTenant('sec-grand', node['sec-child']);
  await mkTenant('sec-sibling', node['sec-root']);
  await mkTenant('sec-other');
  await mkUser('dev', ['agent-developer']);
  await mkUser('dev2', ['agent-developer']);
  await mkUser('integrator', ['integrator']);
  await mkUser('viewer', ['viewer']);
  await mkUser('member', ['viewer']);
  const t1 = await api(tok['sec-root']!, 'POST', '/v1/teams', { slug: 'ops', name: 'Ops' });
  const t2 = await api(tok['sec-root']!, 'POST', '/v1/teams', { slug: 'other', name: 'Other' });
  team = j(t1).id;
  otherTeam = j(t2).id;
  const m = await api(tok['sec-root']!, 'PUT', `/v1/teams/${team}/members`, {
    members: [{ userId: uid['member'], role: 'integrator' }],
  });
  expect(m.statusCode, m.body).toBe(204);
}, 120_000);
afterAll(async () => n?.close());

describe('create and metadata', () => {
  it('creates a tenant secret and returns metadata without the value', async () => {
    const value = canary('create');
    const res = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'db-pass',
      value,
      description: 'database',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(value);
    expect(j(res)).toMatchObject({
      scope: 'tenant',
      name: 'db-pass',
      reference: 'tenant:db-pass',
      version: 1,
      backend: 'internal',
      usage: 'any',
      allowedDestinations: [],
      inherit: true,
      state: 'active',
      inherited: false,
      pointer: null,
      ownerNode: { id: node['sec-root'], slugPath: 'sec-root' },
    });
    expect(Object.keys(j(res)).sort()).not.toEqual(expect.arrayContaining(['value']));
  });

  it('defaults allowOverride to false on a root node and to true below (decision F4)', async () => {
    const root = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'f4-root', value: canary('f4a') }),
    );
    const low = j(
      await create(tok['sec-child']!, { scope: 'tenant', name: 'f4-low', value: canary('f4b') }),
    );
    expect(root.allowOverride).toBe(false);
    expect(low.allowOverride).toBe(true);
    const explicit = j(
      await create(tok['sec-root']!, {
        scope: 'tenant',
        name: 'f4-open',
        value: canary('f4c'),
        allowOverride: true,
      }),
    );
    expect(explicit.allowOverride).toBe(true);
  });

  it.each([
    ['a value shorter than 8 characters', { value: '1234567' }],
    ['a value over 64 KiB', { value: 'x'.repeat(64 * 1024 + 1) }],
    ['no value and no pointer', {}],
    ['a value and a pointer', { value: 'long-enough-value', pointer: 'trivy-hook' }],
    ['an upper-case name', { name: 'Upper', value: 'long-enough-value' }],
    ['an unknown field', { value: 'long-enough-value', secret: 'x' }],
    ['a past expiry', { value: 'long-enough-value', expiresAt: '2000-01-01T00:00:00.000Z' }],
    ['a team secret without a team', { scope: 'team', value: 'long-enough-value' }],
    [
      'inherit on a team secret',
      { scope: 'team', teamId: randomUUID(), value: 'long-enough-value', inherit: true },
    ],
    ['bad destinations', { value: 'long-enough-value', allowedDestinations: ['*'] }],
  ])('refuses %s', async (_label, over) => {
    const res = await create(tok['sec-root']!, { scope: 'tenant', name: 'bad-input', ...over });
    expect(res.statusCode, res.body).toBe(400);
    // an error never echoes the value it refused
    const v = (over as { value?: string }).value;
    if (v) expect(res.body).not.toContain(v);
  });

  it('accepts exactly 8 characters and exactly 64 KiB', async () => {
    expect(
      (await create(tok['sec-root']!, { scope: 'tenant', name: 'min-len', value: '12345678' }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await create(tok['sec-root']!, {
          scope: 'tenant',
          name: 'max-len',
          value: 'x'.repeat(64 * 1024),
        })
      ).statusCode,
    ).toBe(201);
  });

  it('refuses a duplicate name in the same scope and owner', async () => {
    const res = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'db-pass',
      value: canary('dup'),
    });
    expect(res.statusCode).toBe(409);
    expect(j(res).error).toBe('secret_exists');
  });

  it('keeps names of different scopes apart', async () => {
    const t = await create(tok['sec-root']!, {
      scope: 'team',
      teamId: team,
      name: 'db-pass',
      value: canary('scope'),
    });
    expect(t.statusCode, t.body).toBe(201);
    expect(j(t).reference).toBe('team:db-pass');
  });
});

describe('who may do what', () => {
  it('needs secrets:read to see and nothing for a viewer', async () => {
    expect((await list(tok['viewer']!)).statusCode).toBe(403);
    expect((await list(tok['dev']!)).statusCode).toBe(200);
    expect((await list(tok['integrator']!)).statusCode).toBe(200);
  });

  it('lets only secrets:write node-wide manage tenant secrets', async () => {
    const body = { scope: 'tenant', name: 'by-integrator', value: canary('who') };
    expect((await create(tok['dev']!, body)).statusCode).toBe(403);
    expect((await create(tok['integrator']!, body)).statusCode).toBe(201);
    // a team-only binding does not manage tenant secrets
    expect((await create(tok['member']!, { ...body, name: 'by-member' })).statusCode).toBe(403);
  });

  it('lets a team member with secrets:write manage that team only', async () => {
    const mine = await create(tok['member']!, {
      scope: 'team',
      teamId: team,
      name: 'team-key',
      value: canary('team'),
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const theirs = await create(tok['member']!, {
      scope: 'team',
      teamId: otherTeam,
      name: 'team-key',
      value: canary('team2'),
    });
    expect(theirs.statusCode).toBe(403);
    const listed = await list(tok['member']!, `scope=team&teamId=${team}`);
    expect(listed.statusCode).toBe(200);
    expect(j(listed).items.map((i: Json) => i.name)).toContain('team-key');
    expect((await list(tok['member']!, `scope=team&teamId=${otherTeam}`)).statusCode).toBe(403);
    const id = j(mine).id;
    expect(
      (await api(tok['member']!, 'POST', `/v1/secrets/${id}/rotate`, { value: canary('rot') }))
        .statusCode,
    ).toBe(200);
  });

  it('keeps personal secrets to their owner, who needs agents:write', async () => {
    const mine = await create(tok['dev']!, {
      scope: 'personal',
      name: 'my-token',
      value: canary('personal'),
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const id = j(mine).id;
    expect(j(await list(tok['dev']!, 'scope=personal')).items).toHaveLength(1);
    // another developer, a node administrator and the creator's own tenant admin see nothing
    expect(j(await list(tok['dev2']!, 'scope=personal')).items).toHaveLength(0);
    expect(j(await list(tok['sec-root']!, 'scope=personal')).items).toHaveLength(0);
    for (const who of ['dev2', 'sec-root'])
      expect((await api(tok[who]!, 'GET', `/v1/secrets/${id}`)).statusCode, who).toBe(404);
    for (const who of ['dev2', 'sec-root'])
      expect((await api(tok[who]!, 'DELETE', `/v1/secrets/${id}`)).statusCode, who).toBe(404);
    // a viewer has no agents:write and no secrets:read
    expect(
      (await create(tok['viewer']!, { scope: 'personal', name: 'v', value: canary('v') }))
        .statusCode,
    ).toBe(403);
    expect((await api(tok['dev']!, 'DELETE', `/v1/secrets/${id}`)).statusCode).toBe(204);
  });

  it('answers 404 for an unknown secret and for one the caller may not see, alike', async () => {
    const unknown = await api(tok['sec-root']!, 'GET', `/v1/secrets/${randomUUID()}`);
    const [other] = (
      await n.ctx.db.select().from(secrets).where(eq(secrets.name, 'db-pass'))
    ).filter((s) => s.scope === 'tenant');
    const foreign = await api(tok['sec-other']!, 'GET', `/v1/secrets/${other!.id}`);
    expect(foreign.statusCode).toBe(404);
    expect(j(foreign)).toEqual(j(unknown));
  });
});

describe('teams', () => {
  it('deletes the secrets of a team with the team', async () => {
    const t = await api(tok['sec-root']!, 'POST', '/v1/teams', { slug: 'doomed', name: 'Doomed' });
    const teamId = j(t).id as string;
    const made = await create(tok['sec-root']!, {
      scope: 'team',
      teamId,
      name: 'doomed-key',
      value: canary('doomed'),
    });
    expect(made.statusCode, made.body).toBe(201);
    const del = await api(tok['sec-root']!, 'DELETE', `/v1/teams/${teamId}`);
    expect(del.statusCode, del.body).toBe(204);
    const entries = await n.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, j(made).id));
    expect(entries.map((e) => e.action)).toEqual(['secret.created', 'secret.deleted']);
    expect(entries[1]!.payload).toMatchObject({ reason: 'team_deleted', name: 'doomed-key' });
    expect(
      await n.ctx.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, j(made).id)),
    ).toHaveLength(0);
    expect(
      await n.ctx.db
        .select()
        .from(secretVersions)
        .where(eq(secretVersions.secretId, j(made).id)),
    ).toHaveLength(0);
  });
});

describe('rotate, revoke, delete', () => {
  it('rotates to a new version and keeps only the current sealed value', async () => {
    const created = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'rot', value: canary('r1') }),
    );
    const v2 = canary('r2');
    const res = await api(tok['sec-root']!, 'POST', `/v1/secrets/${created.id}/rotate`, {
      value: v2,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(v2);
    expect(j(res)).toMatchObject({ version: 2 });
    expect(j(res).rotatedAt).toBeTruthy();
    const rows = await n.ctx.db
      .select()
      .from(secretVersions)
      .where(eq(secretVersions.secretId, created.id));
    expect(rows.map((r) => r.version)).toEqual([2]);
    expect(
      (await api(tok['sec-root']!, 'POST', `/v1/secrets/${created.id}/rotate`, { value: 'short' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses to rotate a secret of an ancestor from a descendant node', async () => {
    const [root] = await n.ctx.db.select().from(secrets).where(eq(secrets.name, 'db-pass'));
    const res = await api(tok['sec-child']!, 'POST', `/v1/secrets/${root!.id}/rotate`, {
      value: canary('x'),
    });
    expect(res.statusCode).toBe(404);
    for (const path of ['revoke']) {
      expect(
        (await api(tok['sec-child']!, 'POST', `/v1/secrets/${root!.id}/${path}`)).statusCode,
      ).toBe(404);
    }
    expect((await api(tok['sec-child']!, 'DELETE', `/v1/secrets/${root!.id}`)).statusCode).toBe(
      404,
    );
  });

  it('revokes: values gone, name still taken, no rotation afterwards', async () => {
    const created = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'rev', value: canary('rv') }),
    );
    const res = await api(tok['sec-root']!, 'POST', `/v1/secrets/${created.id}/revoke`);
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res)).toMatchObject({ state: 'revoked' });
    expect(
      await n.ctx.db.select().from(secretVersions).where(eq(secretVersions.secretId, created.id)),
    ).toHaveLength(0);
    expect(
      (await api(tok['sec-root']!, 'POST', `/v1/secrets/${created.id}/revoke`)).statusCode,
    ).toBe(409);
    expect(
      (
        await api(tok['sec-root']!, 'POST', `/v1/secrets/${created.id}/rotate`, {
          value: canary('after'),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await create(tok['sec-root']!, { scope: 'tenant', name: 'rev', value: canary('again') }))
        .statusCode,
    ).toBe(409);
  });

  it('deletes the secret with its values and frees the name', async () => {
    const created = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'del', value: canary('dl') }),
    );
    expect((await api(tok['sec-root']!, 'DELETE', `/v1/secrets/${created.id}`)).statusCode).toBe(
      204,
    );
    expect((await api(tok['sec-root']!, 'GET', `/v1/secrets/${created.id}`)).statusCode).toBe(404);
    expect(
      await n.ctx.db.select().from(secretVersions).where(eq(secretVersions.secretId, created.id)),
    ).toHaveLength(0);
    expect(
      (await create(tok['sec-root']!, { scope: 'tenant', name: 'del', value: canary('dl2') }))
        .statusCode,
    ).toBe(201);
  });

  it('expires a secret and shows the state', async () => {
    const soon = new Date(n.ctx.now().getTime() + 3_600_000).toISOString();
    const created = j(
      await create(tok['sec-root']!, {
        scope: 'tenant',
        name: 'exp',
        value: canary('ex'),
        expiresAt: soon,
      }),
    );
    expect(created.state).toBe('active');
    await n.ctx.db
      .update(secrets)
      .set({ expiresAt: new Date(n.ctx.now().getTime() - 1000) })
      .where(eq(secrets.id, created.id));
    expect(j(await api(tok['sec-root']!, 'GET', `/v1/secrets/${created.id}`)).state).toBe(
      'expired',
    );
  });
});

describe('inheritance of metadata', () => {
  it('shows ancestors inheritable secrets to a descendant, flagged, without the creator', async () => {
    await create(tok['sec-root']!, { scope: 'tenant', name: 'org-wide', value: canary('ow') });
    await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'root-only',
      value: canary('ro'),
      inherit: false,
    });
    await create(tok['sec-child']!, { scope: 'tenant', name: 'child-own', value: canary('co') });
    const seen = j(await list(tok['sec-grand']!)).items as Json[];
    const names = seen.map((i) => i.name);
    expect(names).toContain('org-wide');
    expect(names).toContain('child-own');
    expect(names).not.toContain('root-only');
    const inherited = seen.find((i) => i.name === 'org-wide')!;
    expect(inherited).toMatchObject({ inherited: true, createdBy: null, pointer: null });
    expect(inherited.ownerNode.slugPath).toBe('sec-root');
    expect(seen.find((i) => i.name === 'child-own')).toMatchObject({ inherited: true });
    expect(seen.find((i) => i.name === 'child-own')!.ownerNode.slugPath).toBe('sec-root/sec-child');
  });

  it('never shows a descendant or a sibling secret to an ancestor or a sibling', async () => {
    const root = (j(await list(tok['sec-root']!)).items as Json[]).map((i) => i.name);
    expect(root).not.toContain('child-own');
    const sibling = (j(await list(tok['sec-sibling']!)).items as Json[]).map((i) => i.name);
    expect(sibling).not.toContain('child-own');
    expect(sibling).toContain('org-wide');
    const other = (j(await list(tok['sec-other']!)).items as Json[]).map((i) => i.name);
    expect(other).not.toContain('org-wide');
  });

  it('serves the metadata of an inherited secret by id, and not across organisations', async () => {
    const [row] = await n.ctx.db.select().from(secrets).where(eq(secrets.name, 'org-wide'));
    expect((await api(tok['sec-grand']!, 'GET', `/v1/secrets/${row!.id}`)).statusCode).toBe(200);
    expect((await api(tok['sec-other']!, 'GET', `/v1/secrets/${row!.id}`)).statusCode).toBe(404);
    const [only] = await n.ctx.db.select().from(secrets).where(eq(secrets.name, 'root-only'));
    expect((await api(tok['sec-grand']!, 'GET', `/v1/secrets/${only!.id}`)).statusCode).toBe(404);
  });

  it('pages a long list with a cursor', async () => {
    const first = j(await list(tok['sec-root']!, 'scope=tenant&limit=3'));
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = j(
      await list(tok['sec-root']!, `scope=tenant&limit=3&cursor=${first.nextCursor}`),
    );
    const ids = new Set([...first.items, ...second.items].map((i: Json) => i.id));
    expect(ids.size).toBe(6);
  });
});

describe('shadowing', () => {
  it('refuses a same-named secret below one with allowOverride:false (secret_name_reserved)', async () => {
    await create(tok['sec-root']!, { scope: 'tenant', name: 'reserved', value: canary('rs') });
    for (const who of ['sec-child', 'sec-grand', 'sec-sibling']) {
      const res = await create(tok[who]!, {
        scope: 'tenant',
        name: 'reserved',
        value: canary('rs2'),
      });
      expect(res.statusCode, who).toBe(422);
      expect(j(res).error).toBe('secret_name_reserved');
    }
  });

  it('allows overriding when the owner said so, and audits secret.shadowed', async () => {
    await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'soft',
      value: canary('sf'),
      allowOverride: true,
    });
    const res = await create(tok['sec-child']!, {
      scope: 'tenant',
      name: 'soft',
      value: canary('sf2'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const entries = await n.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'secret.shadowed'));
    expect(
      entries.some(
        (e) =>
          (e.payload as Json).name === 'soft' &&
          (e.payload as Json).shadowedNode === node['sec-child'],
      ),
    ).toBe(true);
  });

  it('does not reserve a name that the owner keeps node-only', async () => {
    await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'node-only',
      value: canary('no'),
      inherit: false,
    });
    expect(
      (
        await create(tok['sec-child']!, {
          scope: 'tenant',
          name: 'node-only',
          value: canary('no2'),
        })
      ).statusCode,
    ).toBe(201);
  });

  it('lets a team or personal secret use the name of a reserved tenant secret', async () => {
    expect(
      (
        await create(tok['sec-root']!, {
          scope: 'team',
          teamId: team,
          name: 'reserved',
          value: canary('tt'),
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('a reservation cannot be created over an existing name below', () => {
  it('refuses a reserving secret while a node below already owns the name', async () => {
    await create(tok['sec-grand']!, { scope: 'tenant', name: 'below-first', value: canary('bf') });
    const res = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'below-first',
      value: canary('bf2'),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(j(res).error).toBe('secret_name_conflict');
    expect(res.body).not.toContain('sec-grand');
    // allowed once the owner lets the name be shadowed, or keeps it node-only
    expect(
      (
        await create(tok['sec-root']!, {
          scope: 'tenant',
          name: 'below-first',
          value: canary('bf3'),
          allowOverride: true,
        })
      ).statusCode,
    ).toBe(201);
    await create(tok['sec-grand']!, { scope: 'tenant', name: 'below-second', value: canary('bs') });
    expect(
      (
        await create(tok['sec-root']!, {
          scope: 'tenant',
          name: 'below-second',
          value: canary('bs2'),
          inherit: false,
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('blocking inherited names', () => {
  it('stores the globs on the acting node and reports the effective union', async () => {
    const put = await api(tok['sec-child']!, 'PUT', '/v1/secrets/policy', {
      blockInherited: ['org-*', 'org-*', 'x'],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(j(put).blockInherited).toEqual(['org-*', 'x']);
    const grand = j(await api(tok['sec-grand']!, 'GET', '/v1/secrets/policy'));
    expect(grand.blockInherited).toEqual([]);
    expect(grand.effectiveBlocked).toEqual(['org-*', 'x']);
  });

  it('is for secrets:write and takes name globs only', async () => {
    expect(
      (await api(tok['dev']!, 'PUT', '/v1/secrets/policy', { blockInherited: ['a'] })).statusCode,
    ).toBe(403);
    expect(
      (await api(tok['sec-child']!, 'PUT', '/v1/secrets/policy', { blockInherited: ['UP'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api(tok['sec-child']!, 'PUT', '/v1/secrets/policy', { blockInherited: ['a/b'] }))
        .statusCode,
    ).toBe(400);
  });
});

describe('the import helper (pointers to operator secrets)', () => {
  it('creates a pointer only for a reference the tenant allows and that exists', async () => {
    const t = await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${node['sec-root']}`,
      payload: { secretRefs: ['trivy-hook', 'oai-key', 'not-configured'] },
    });
    expect(t.statusCode, t.body).toBe(200);
    const ok = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'imported',
      pointer: 'trivy-hook',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(j(ok)).toMatchObject({ backend: 'env', pointer: 'trivy-hook', version: 1 });
    expect(ok.body).not.toContain('hook-secret-1');
    // nothing was copied into the store
    expect(
      await n.ctx.db
        .select()
        .from(secretVersions)
        .where(eq(secretVersions.secretId, j(ok).id)),
    ).toHaveLength(0);
    const gone = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'gone',
      pointer: 'not-configured',
    });
    expect(gone.statusCode).toBe(422);
    expect(j(gone).error).toBe('secret_not_found');
    const closed = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'closed',
      pointer: 'mail-hook',
    });
    expect(closed.statusCode).toBe(422);
    expect(j(closed).error).toBe('secret_pointer_not_allowed');
    // a platform secret is refused even though the tenant allowlist names it
    const platform = await create(tok['sec-root']!, {
      scope: 'tenant',
      name: 'plat',
      pointer: 'oai-key',
    });
    expect(platform.statusCode).toBe(422);
    expect(j(platform).error).toBe('secret_pointer_not_allowed');
    expect(
      (
        await api(tok['sec-root']!, 'POST', `/v1/secrets/${j(ok).id}/rotate`, {
          value: canary('p'),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('does not offer pointers for personal secrets', async () => {
    const res = await create(tok['dev']!, { scope: 'personal', name: 'p', pointer: 'trivy-hook' });
    expect(res.statusCode).toBe(400);
  });
});

describe('without a key-encryption key', () => {
  it('fails closed with 503 and stores nothing', async () => {
    const bare = await testNode({});
    try {
      const res = await bare.req({
        method: 'POST',
        url: '/v1/secrets',
        payload: { scope: 'tenant', name: 'no-kek', value: 'long-enough-value' },
      });
      expect(res.statusCode, res.body).toBe(503);
      expect(j(res).error).toBe('key_service_unconfigured');
      expect(await bare.ctx.db.select().from(secrets)).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});

describe('a value is never readable (canaries)', () => {
  it('appears in no response, no audit entry and no table, only sealed', async () => {
    const value = canary('final');
    const made = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'canary-final', value }),
    );
    await api(tok['sec-root']!, 'POST', `/v1/secrets/${made.id}/rotate`, {
      value: canary('final2'),
    });
    // every secrets response and every audit page
    const bodies = [
      (await list(tok['sec-root']!, 'scope=tenant&limit=200')).body,
      (await api(tok['sec-root']!, 'GET', `/v1/secrets/${made.id}`)).body,
      (await api(tok['sec-grand']!, 'GET', '/v1/secrets/policy')).body,
      (await api(tok['sec-root']!, 'GET', '/v1/audit?limit=200')).body,
    ];
    for (const b of bodies) for (const c of canaries) expect(b).not.toContain(c);
    // the audit table as stored
    const audit = JSON.stringify(await n.ctx.db.select().from(auditLog));
    for (const c of canaries) expect(audit).not.toContain(c);
    // the secret tables as stored: ciphertext, never the value
    const stored = JSON.stringify([
      await n.ctx.db.select().from(secrets),
      await n.ctx.db.select().from(secretVersions),
    ]);
    for (const c of canaries) expect(stored).not.toContain(c);
    expect(stored).toContain('oaxe1.');
  });

  it('has no response schema with a value, ciphertext or key in the OpenAPI document', () => {
    const doc = n.app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components?: { schemas?: Record<string, unknown> };
    };
    const FORBIDDEN = new Set(['value', 'ciphertext', 'plaintext', 'secret', 'key', 'dek', 'kek']);
    const props = (node: unknown, seen = new Set<unknown>()): string[] => {
      if (!node || typeof node !== 'object' || seen.has(node)) return [];
      seen.add(node);
      const out: string[] = [];
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'properties' && v && typeof v === 'object') out.push(...Object.keys(v));
        out.push(...props(v, seen));
      }
      return out;
    };
    for (const [path, methods] of Object.entries(doc.paths)) {
      if (!path.startsWith('/v1/secrets')) continue;
      for (const [method, op] of Object.entries(methods)) {
        const names = props(op.responses);
        for (const f of FORBIDDEN)
          expect(names, `${method.toUpperCase()} ${path} response has "${f}"`).not.toContain(f);
      }
    }
    // the value is a request field of exactly two operations
    const takesValue = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => props((op as { requestBody?: unknown }).requestBody).includes('value'))
        .map(([m]) => `${m.toUpperCase()} ${path}`),
    );
    expect(takesValue.filter((s) => s.includes('/v1/secrets')).sort()).toEqual([
      'POST /v1/secrets',
      'POST /v1/secrets/{id}/rotate',
    ]);
  });
});

describe('audit', () => {
  it('records create, rotate, revoke, delete with ids and metadata only', async () => {
    const made = j(
      await create(tok['sec-root']!, { scope: 'tenant', name: 'audited', value: canary('au') }),
    );
    await api(tok['sec-root']!, 'POST', `/v1/secrets/${made.id}/rotate`, { value: canary('au2') });
    await api(tok['sec-root']!, 'POST', `/v1/secrets/${made.id}/revoke`);
    await api(tok['sec-root']!, 'DELETE', `/v1/secrets/${made.id}`);
    const rows = (await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, made.id))).sort(
      (a, b) => Number(a.seq) - Number(b.seq),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'secret.created',
      'secret.rotated',
      'secret.revoked',
      'secret.deleted',
    ]);
    expect(rows[0]!.payload).toEqual({
      scope: 'tenant',
      scopeId: node['sec-root'],
      name: 'audited',
      version: 1,
      backend: 'internal',
      inherit: true,
    });
    expect((rows[1]!.payload as Json).version).toBe(2);
  });
});
