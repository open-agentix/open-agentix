import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LdapClientLike } from '../src/auth/ldap.js';
import { escapeLdapFilter, ldapAuthenticate } from '../src/auth/ldap.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { parseToken } from '../src/auth/tokens.js';
import type { OidcClient } from '../src/auth/oidc.js';
import { pkceChallenge, randomOidcValues, openidClient } from '../src/auth/oidc.js';
import { testNode, type TestNode } from './helpers.js';

function fakeLdap(
  users: Record<
    string,
    { password: string; dn: string; mail?: string; cn?: string; groups: string[] }
  >,
) {
  const log: string[] = [];
  const factory = (): LdapClientLike => ({
    bind: async (dn, password) => {
      log.push(`bind ${dn}`);
      if (dn === 'cn=svc,dc=example,dc=com' && password === 'svc-pw') return;
      const u = Object.values(users).find((x) => x.dn === dn);
      if (!u || u.password !== password) throw new Error('invalid credentials');
    },
    search: async (_base, opts) => {
      log.push(`search ${opts.filter}`);
      const name = /\(uid=(.*)\)/.exec(opts.filter)?.[1] ?? '';
      const u = users[name];
      return {
        searchEntries: u
          ? [
              {
                dn: u.dn,
                mail: u.mail,
                cn: u.cn,
                memberOf: u.groups.length === 1 ? u.groups[0] : u.groups,
              },
            ]
          : [],
      };
    },
    unbind: async () => void log.push('unbind'),
  });
  return { factory, log };
}

const ldapUsers = {
  alice: {
    password: 'alice-pw',
    dn: 'uid=alice,ou=people,dc=example,dc=com',
    mail: 'alice@example.com',
    cn: 'Alice',
    groups: ['cn=oax-operators,ou=groups,dc=example,dc=com', 'cn=other'],
  },
  bob: {
    password: 'bob-pw',
    dn: 'uid=bob,ou=people,dc=example,dc=com',
    groups: ['cn=oax-admins,ou=groups,dc=example,dc=com'],
  },
};

let n: TestNode;
const ldap = fakeLdap(ldapUsers);
const oidcCalls: string[] = [];
const oidc: OidcClient = {
  authorizationUrl: async ({ state, codeChallenge }) =>
    `https://idp.example.com/auth?state=${state}&code_challenge=${codeChallenge}`,
  exchange: async (url, check) => {
    oidcCalls.push(
      `${url.searchParams.get('code')}:${check.state === url.searchParams.get('state')}`,
    );
    return { sub: 'u-1', email: 'carol@example.com', name: 'Carol', groups: ['oax-auditors'] };
  },
};

beforeAll(async () => {
  n = await testNode(
    {
      OAX_LDAP_URL: 'ldaps://ldap.example.com',
      OAX_LDAP_BIND_DN: 'cn=svc,dc=example,dc=com',
      OAX_LDAP_BIND_PASSWORD: 'svc-pw',
      OAX_LDAP_USER_BASE_DN: 'ou=people,dc=example,dc=com',
      OAX_LDAP_ROLE_MAPPING: JSON.stringify({
        'cn=oax-operators,ou=groups,dc=example,dc=com': ['operator@team-security', 'viewer'],
        'cn=oax-admins,ou=groups,dc=example,dc=com': 'admin',
      }),
      OAX_OIDC_ISSUER: 'https://idp.example.com',
      OAX_OIDC_CLIENT_ID: 'oax',
      OAX_OIDC_REDIRECT_URI: 'http://localhost:8080/v1/auth/oidc/callback',
      OAX_OIDC_ROLE_MAPPING: JSON.stringify({ 'oax-auditors': 'auditor' }),
      OAX_RATE_LIMIT_LOGIN_MAX: '50',
    },
    { ldapFactory: ldap.factory, oidcClient: oidc },
  );
  await n.req({
    method: 'POST',
    url: '/v1/teams',
    payload: { slug: 'team-security', name: 'Security' },
  });
});
afterAll(async () => n.close());

describe('passwords and tokens', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('secret-password');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('secret-password', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
    expect(parseToken('nope')).toBeNull();
  });
});

describe('local login and sessions', () => {
  it('logs in, reads /v1/me and logs out', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/auth/login',
      token: null,
      payload: { username: 'ADMIN@example.com', password: 'admin-password-123', method: 'local' },
    });
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    const me = (await n.req({ method: 'GET', url: '/v1/me', token })).json();
    expect(me).toMatchObject({
      kind: 'user',
      user: { email: 'admin@example.com', globalRoles: ['admin'] },
    });
    expect(me.permissions).toContain('audit:export');
    expect((await n.req({ method: 'POST', url: '/v1/auth/logout', token })).statusCode).toBe(204);
    expect((await n.req({ method: 'GET', url: '/v1/me', token })).statusCode).toBe(401);
  });

  it('rejects wrong passwords, malformed and unknown tokens', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'admin@example.com', password: 'nope' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'ghost@example.com', password: 'x', method: 'local' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await n.req({ method: 'GET', url: '/v1/me', token: 'garbage' })).statusCode).toBe(401);
    expect(
      (
        await n.req({
          method: 'GET',
          url: '/v1/me',
          token: `oax_0123456789abcdef_${'x'.repeat(43)}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await n.req({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: 'Basic abc' },
          token: null,
        })
      ).statusCode,
    ).toBe(401);
    const tampered = `${n.admin.slice(0, -4)}AAAA`;
    expect((await n.req({ method: 'GET', url: '/v1/me', token: tampered })).statusCode).toBe(401);
  });

  it('only creates the bootstrap admin once', async () => {
    expect(await n.services.identity.ensureBootstrapAdmin()).toBe(false);
  });
});

describe('API tokens', () => {
  it('creates scoped tokens capped to own permissions, lists and revokes them', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      payload: { name: 'ci', scopes: ['runs:read'], expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect((await n.req({ method: 'GET', url: '/v1/runs', token })).statusCode).toBe(200);
    expect((await n.req({ method: 'GET', url: '/v1/agents', token })).statusCode).toBe(403);
    expect((await n.req({ method: 'GET', url: '/v1/me', token })).json().kind).toBe('token');
    const list = (await n.req({ method: 'GET', url: '/v1/tokens' })).json().items;
    expect(list.map((t: { id: string }) => t.id)).toContain(id);
    expect(
      (await n.req({ method: 'GET', url: '/v1/tokens?all=true' })).json().items.length,
    ).toBeGreaterThanOrEqual(1);
    expect((await n.req({ method: 'DELETE', url: `/v1/tokens/${id}` })).statusCode).toBe(204);
    expect((await n.req({ method: 'GET', url: '/v1/runs', token })).statusCode).toBe(401);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/tokens/${id.replace(/./, 'f')}` })).statusCode,
    ).toBe(404);
  });

  it('refuses scopes beyond the principal', async () => {
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'eng@example.com',
        displayName: 'Eng',
        password: 'engineer-password',
        globalRoles: ['agent-engineer'],
      },
    });
    const eng = await n.login('eng@example.com', 'engineer-password');
    const res = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      token: eng,
      payload: { name: 'x', scopes: ['audit:export'] },
    });
    expect(res.statusCode).toBe(403);
    const ok = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      token: eng,
      payload: { name: 'y' },
    });
    expect(ok.json().scopes).toContain('agents:publish');
  });
});

describe('LDAP', () => {
  it('binds, maps groups to global and team roles', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/auth/login',
      token: null,
      payload: { username: 'alice', password: 'alice-pw' },
    });
    expect(res.statusCode).toBe(200);
    const me = (await n.req({ method: 'GET', url: '/v1/me', token: res.json().token })).json();
    expect(me.user).toMatchObject({
      email: 'alice@example.com',
      source: 'ldap',
      globalRoles: ['viewer'],
    });
    expect(me.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'operator' })]),
    );
    expect(ldap.log).toContain('search (uid=alice)');
    const bob = await n.req({
      method: 'POST',
      url: '/v1/auth/login',
      token: null,
      payload: { username: 'bob', password: 'bob-pw', method: 'ldap' },
    });
    expect(bob.json().user).toMatchObject({
      email: 'bob@ldap.invalid',
      globalRoles: ['admin'],
      displayName: 'bob',
    });
  });

  it('rejects bad passwords, unknown users and filter injection', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'alice', password: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'nobody', password: 'x', method: 'ldap' },
        })
      ).statusCode,
    ).toBe(401);
    expect(escapeLdapFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    await expect(
      ldapAuthenticate(
        {
          url: 'x',
          bindDn: undefined,
          bindPassword: undefined,
          userBaseDn: 'b',
          userFilter: '(uid={username})',
          groupAttribute: 'memberOf',
          roleMapping: {},
          tlsRejectUnauthorized: true,
        },
        'a',
        '',
        ldap.factory,
      ),
    ).rejects.toThrow(/invalid/);
  });

  it('disables users via the API', async () => {
    const users = (await n.req({ method: 'GET', url: '/v1/users' })).json().items as {
      id: string;
      email: string;
    }[];
    const alice = users.find((u) => u.email === 'alice@example.com')!;
    const res = await n.req({
      method: 'PATCH',
      url: `/v1/users/${alice.id}`,
      payload: { disabled: true, displayName: 'Alice A.' },
    });
    expect(res.json()).toMatchObject({ disabled: true, displayName: 'Alice A.' });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'alice', password: 'alice-pw' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await n.req({
          method: 'PATCH',
          url: '/v1/users/00000000-0000-4000-8000-000000000000',
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('OIDC', () => {
  it('redirects with PKCE and completes the callback', async () => {
    const start = await n.req({ method: 'GET', url: '/v1/auth/oidc/login', token: null });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get('state')!;
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    const cb = await n.req({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=abc&state=${state}`,
      token: null,
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.json().user).toMatchObject({
      email: 'carol@example.com',
      source: 'oidc',
      globalRoles: ['auditor'],
    });
    expect(oidcCalls).toEqual(['abc:true']);
    const replay = await n.req({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=abc&state=${state}`,
      token: null,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('exposes helpers and a lazily discovering openid-client wrapper', async () => {
    const v = randomOidcValues();
    expect(await pkceChallenge(v.codeVerifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      typeof openidClient({
        issuer: 'https://idp.invalid',
        clientId: 'x',
        clientSecret: undefined,
        redirectUri: 'https://x/cb',
        scopes: 'openid',
        groupsClaim: 'groups',
        roleMapping: {},
      }).authorizationUrl,
    ).toBe('function');
  });

  it('lists enabled login methods and redirects to the UI with token and expiry', async () => {
    expect((await n.req({ method: 'GET', url: '/v1/auth/methods', token: null })).json()).toEqual({
      local: true,
      ldap: true,
      oidc: { enabled: true, loginUrl: '/v1/auth/oidc/login' },
    });
    const ui = await testNode(
      {
        OAX_UI_URL: 'https://ui.example.com',
        OAX_OIDC_ISSUER: 'https://idp.example.com',
        OAX_OIDC_CLIENT_ID: 'oax',
        OAX_OIDC_REDIRECT_URI: 'http://localhost:8080/v1/auth/oidc/callback',
      },
      { oidcClient: oidc },
    );
    const start = await ui.req({ method: 'GET', url: '/v1/auth/oidc/login', token: null });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await ui.req({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=x&state=${state}`,
      token: null,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toMatch(
      /^https:\/\/ui\.example\.com\/auth\/callback#token=oax_[^&]+&expiresAt=\d{4}-/,
    );
    await ui.close();
  });

  it('returns 404 when OIDC is not configured', async () => {
    const plain = await testNode();
    expect(
      (await plain.req({ method: 'GET', url: '/v1/auth/methods', token: null })).json(),
    ).toEqual({
      local: true,
      ldap: false,
      oidc: { enabled: false, loginUrl: null },
    });
    expect(
      (await plain.req({ method: 'GET', url: '/v1/auth/oidc/login', token: null })).statusCode,
    ).toBe(404);
    expect(
      (await plain.req({ method: 'GET', url: '/v1/auth/oidc/callback?state=x', token: null }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await plain.req({
          method: 'POST',
          url: '/v1/auth/login',
          token: null,
          payload: { username: 'x', password: 'y', method: 'ldap' },
        })
      ).statusCode,
    ).toBe(401);
    await plain.close();
  });
});

describe('users and teams', () => {
  it('creates users and teams, sets members and rejects duplicates', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/users',
          payload: { email: 'eng@example.com', displayName: 'Dup', password: 'engineer-password' },
        })
      ).statusCode,
    ).toBe(409);
    const team = await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-ops', name: 'Ops', monthlyBudgetUsd: 25 },
    });
    expect(team.json()).toMatchObject({ slug: 'team-ops', monthlyBudgetUsd: 25 });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/teams',
          payload: { slug: 'team-ops', name: 'Ops' },
        })
      ).statusCode,
    ).toBe(409);
    const users = (await n.req({ method: 'GET', url: '/v1/users' })).json().items as {
      id: string;
      email: string;
    }[];
    const eng = users.find((u) => u.email === 'eng@example.com')!;
    expect(
      (
        await n.req({
          method: 'PUT',
          url: `/v1/teams/${team.json().id}/members`,
          payload: { members: [{ userId: eng.id, role: 'operator' }] },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await n.req({
          method: 'PUT',
          url: '/v1/teams/00000000-0000-4000-8000-000000000000/members',
          payload: { members: [] },
        })
      ).statusCode,
    ).toBe(404);
    expect((await n.req({ method: 'GET', url: `/v1/users/${eng.id}` })).json().email).toBe(
      'eng@example.com',
    );
    expect(
      (await n.req({ method: 'GET', url: '/v1/users/00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(404);
    const members = (
      await n.req({ method: 'GET', url: `/v1/teams/${team.json().id}/members` })
    ).json().items;
    expect(members).toEqual([
      { userId: eng.id, email: 'eng@example.com', displayName: 'Eng', role: 'operator' },
    ]);
    const tmp = (
      await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-tmp', name: 'Tmp' } })
    ).json();
    await n.req({
      method: 'PUT',
      url: `/v1/teams/${tmp.id}/members`,
      payload: { members: [{ userId: eng.id, role: 'viewer' }] },
    });
    expect((await n.req({ method: 'DELETE', url: `/v1/teams/${tmp.id}` })).statusCode).toBe(204);
    expect((await n.req({ method: 'GET', url: `/v1/teams/${tmp.id}/members` })).statusCode).toBe(
      404,
    );
    const owner = (
      await n.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-owner', name: 'Owner' },
      })
    ).json();
    const src =
      '---\napiVersion: openagentix.io/v1alpha1\nkind: Agent\nname: owned\nversion: 1.0.0\nowner: team-owner\nagents:\n  - { id: a, provider: simulated, model: m, instructions: x }\n---\n';
    expect(
      (await n.req({ method: 'POST', url: '/v1/agents', payload: { source: src } })).statusCode,
    ).toBe(201);
    expect((await n.req({ method: 'DELETE', url: `/v1/teams/${owner.id}` })).statusCode).toBe(409);
    const teams = (await n.req({ method: 'GET', url: '/v1/teams' })).json().items;
    expect(teams.map((t: { slug: string }) => t.slug)).toEqual([
      'team-ops',
      'team-owner',
      'team-security',
    ]);
  });

  it('rate-limits login attempts', async () => {
    const limited = await testNode({ OAX_RATE_LIMIT_LOGIN_MAX: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (
          await limited.req({
            method: 'POST',
            url: '/v1/auth/login',
            token: null,
            payload: { username: 'x@example.com', password: 'y' },
          })
        ).statusCode,
      );
    expect(codes).toContain(429);
    await limited.close();
  });
});
