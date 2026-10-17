import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentRoleBindings,
  teamMembers,
  teams,
  tenantRoleBindings,
  users,
} from '../src/db/schema.js';
import { followGrantChain } from '../src/services/approver-facts.js';
import {
  chainForGrant,
  creatorChainOf,
  storedChainOf,
  widenedChain,
} from '../src/services/grant-chain.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * Finding 1 and 2 of #356 (S3 blockers from the review of #354): the grant chain of rule A4 is
 * stored on the row when the grant is made, so a link that is revoked, expires or is deleted after
 * the fact does not launder the approver; widening records every grantor; an account that lost its
 * creator is not clean. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let adminA: string; // organisation administrator, never a contributor
let orgA: string;
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};
let seq = 0;

const req = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  n.req({ method, url, token, ...(payload === undefined ? {} : { payload: payload as object }) });
const j = (res: { json: () => unknown }) => res.json() as Json;

async function mkUser(key: string, globalRoles: string[], by = adminA) {
  const res = await req(by, 'POST', '/v1/users', {
    email: `${key}@chain.example.org`,
    displayName: key,
    password: PW,
    globalRoles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@chain.example.org`, PW);
}
const grant = async (by: string, userKey: string, role: string, extra: Json = {}) => {
  const res = await req(by, 'POST', `/v1/tenants/${orgA}/role-bindings`, {
    userId: uid[userKey],
    role,
    inherit: false,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return j(res).id as string;
};
async function newAgent(by: string) {
  const name = `chain-agent-${++seq}`;
  const res = await req(by, 'POST', '/v1/agents', {
    source: agentSource(name, 'nobody', '1.0.0'),
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id as string, name };
}
const open = async (by: string, agentId: string) => {
  const res = await req(by, 'POST', `/v1/agents/${agentId}/reviews`);
  expect(res.statusCode, res.body).toBe(201);
  return j(res);
};
const decide = (by: string, review: Json) =>
  req(by, 'POST', `/v1/reviews/${review.id}/decisions`, {
    decision: 'approve',
    expectedDigest: review.revision.digest,
    expectedExpansionDigest: review.digests.expansionDigest,
    expectedResolutionDigest: review.digests.resolutionDigest,
    expectedPolicyDigest: review.digests.policyDigest,
  });
/** `who` (a maintainer) approves a review of a contributor `c`, and a clean one for control. */
async function outcome(who: string, contributor: string) {
  const review = await open(tok[contributor]!, (await newAgent(tok[contributor]!)).id);
  return decide(tok[who]!, review);
}
const refusedBy = async (who: string, contributor: string) => {
  const res = await outcome(who, contributor);
  expect(res.statusCode, res.body).toBe(403);
  return res.json().error as string;
};
const approves = async (who: string) => {
  const res = await outcome(who, 'author');
  expect(res.statusCode, res.body).toBe(201);
};
const bindingOf = async (userKey: string, role: string) => {
  const [row] = await n.ctx.db
    .select()
    .from(tenantRoleBindings)
    .where(and(eq(tenantRoleBindings.userId, uid[userKey]!), eq(tenantRoleBindings.role, role)));
  return row!;
};

beforeAll(async () => {
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode({
    OAX_DATABASE_URL: db.url,
    OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
    OAX_ROLE_BINDINGS_READ: 'bindings',
    OAX_RATE_LIMIT_LOGIN_MAX: '1000',
  });
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug: 'org-chain',
      name: 'org-chain',
      admin: { email: 'admin@chain.example.org', displayName: 'Admin', password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  orgA = j(r).id;
  adminA = await n.login('admin@chain.example.org', PW);
  uid['adminA'] = (
    await n.ctx.db.select().from(users).where(eq(users.email, 'admin@chain.example.org'))
  )[0]!.id;
  await mkUser('author', ['agent-maintainer']);
  await mkUser('c', ['admin']); // the contributor with grant rights
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

/** C grants D admin, D grants X agent-maintainer; X never touched a draft, D neither. */
async function launder(key: string, adminExtra: Json = {}) {
  await mkUser(`${key}-d`, []);
  await mkUser(`${key}-x`, []);
  const dAdmin = await grant(tok['c']!, `${key}-d`, 'admin', adminExtra);
  tok[`${key}-d`] = await n.login(`${key}-d@chain.example.org`, PW);
  await grant(tok[`${key}-d`]!, `${key}-x`, 'agent-maintainer');
  return { dAdmin };
}

describe('finding 1: the stored chain survives the removal of a link', () => {
  it('refuses X, and records C in the chain of X, although C removed the admin binding of D afterwards', async () => {
    const { dAdmin } = await launder('rev');
    // control: while the chain is intact X is refused
    expect(await refusedBy('rev-x', 'c')).toBe('binding_granted_by_contributor');
    const stored = await bindingOf('rev-x', 'agent-maintainer');
    expect(stored.grantChain).toEqual(expect.arrayContaining([uid['c'], uid['rev-d']]));
    // C (or anybody) removes the link: D is no longer an administrator
    const del = await req(adminA, 'DELETE', `/v1/tenants/${orgA}/role-bindings/${dAdmin}`);
    expect(del.statusCode, del.body).toBe(204);
    expect(await refusedBy('rev-x', 'c')).toBe('binding_granted_by_contributor');
    // the same binding still works for work neither C nor D touched
    await approves('rev-x');
  });

  it('keeps refusing after the admin binding of D expired', async () => {
    await launder('exp', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(eq(tenantRoleBindings.userId, uid['exp-d']!), eq(tenantRoleBindings.role, 'admin')),
      );
    expect(await refusedBy('exp-x', 'c')).toBe('binding_granted_by_contributor');
    await approves('exp-x');
  });

  it('keeps refusing after the account of D was deleted', async () => {
    await launder('del');
    await n.ctx.db.delete(users).where(eq(users.id, uid['del-d']!));
    const row = await bindingOf('del-x', 'agent-maintainer');
    expect(row.grantedBy).toBeNull(); // the foreign key nulled it ...
    expect(row.grantorUnknown).toBe(false); // ... and the chain, not a flag, keeps it attributable
    expect(row.grantChain).toEqual(expect.arrayContaining([uid['c'], uid['del-d']]));
    expect(await refusedBy('del-x', 'c')).toBe('binding_granted_by_contributor');
    await approves('del-x');
  });

  it('keeps refusing after the account of the contributor who made the reviewer was deleted', async () => {
    await mkUser('c2', ['admin']);
    await mkUser('y', [], tok['c2']!); // made by C2
    await grant(adminA, 'y', 'agent-maintainer'); // a clean administrator gives the role
    const y = (await n.ctx.db.select().from(users).where(eq(users.id, uid['y']!)))[0]!;
    expect(y.grantChain).toEqual(expect.arrayContaining([uid['c2']]));
    await n.ctx.db.delete(users).where(eq(users.id, uid['c2']!));
    const after = (await n.ctx.db.select().from(users).where(eq(users.id, uid['y']!)))[0]!;
    expect(after.createdBy).toBeNull();
    expect(after.creatorUnknown).toBe(false);
    // C2 is gone, but the review below carries C2 as a contributor id (revisions have no foreign key)
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    expect(creatorChainOf(after).users).toContain(uid['c2']);
    // nothing of the chain is a contributor of this review, so Y approves ...
    expect((await decide(tok['y']!, review)).statusCode).toBe(201);
  });

  it('refuses a binding that a contributor widened after a clean administrator granted it, and records both', async () => {
    await mkUser('wide', []);
    const id = await grant(adminA, 'wide', 'agent-maintainer', {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const before = await bindingOf('wide', 'agent-maintainer');
    expect(before.grantChain).toEqual(expect.arrayContaining([uid['adminA']!]));
    await approves('wide');
    // C extends the expiry: a wider grant
    const res = await req(tok['c']!, 'PATCH', `/v1/tenants/${orgA}/role-bindings/${id}`, {
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await bindingOf('wide', 'agent-maintainer');
    expect(after.grantedBy).toBe(before.grantedBy); // the first grantor is kept ...
    expect(after.grantChain).toEqual(expect.arrayContaining([uid['c']!, ...before.grantChain!])); // ... and C joins
    expect(await refusedBy('wide', 'c')).toBe('binding_granted_by_contributor');
  });

  it('widening keeps an unknown chain unknown and a nobody row takes the actor chain', () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    expect(
      widenedChain({ grantedBy: c1, grantorUnknown: false, grantChain: null }, [c2]),
    ).toBeNull();
    expect(
      widenedChain({ grantedBy: null, grantorUnknown: true, grantChain: null }, [c2]),
    ).toBeNull();
    expect(
      widenedChain({ grantedBy: null, grantorUnknown: false, grantChain: null }, [c2]),
    ).toEqual([c2]);
    expect(widenedChain({ grantedBy: c1, grantorUnknown: false, grantChain: [c1] }, [c2])).toEqual(
      [c1, c2].sort(),
    );
    expect(
      widenedChain({ grantedBy: c1, grantorUnknown: false, grantChain: [c1] }, null),
    ).toBeNull();
  });

  it('team and agent memberships saved by an administrator carry the chain of that administrator', async () => {
    await mkUser('tm', []);
    const team = j(await req(adminA, 'POST', '/v1/teams', { slug: 'chain-team', name: 'T' })).id;
    // C saves the team's member list
    const put = await req(tok['c']!, 'PUT', `/v1/teams/${team}/members`, {
      members: [{ userId: uid['tm'], role: 'agent-maintainer' }],
    });
    expect(put.statusCode, put.body).toBe(204);
    const [row] = await n.ctx.db.select().from(teamMembers).where(eq(teamMembers.teamId, team));
    expect(row!.grantChain).toEqual(expect.arrayContaining([uid['c']]));
    // saved again by the clean administrator: the row stays C's
    const again = await req(adminA, 'PUT', `/v1/teams/${team}/members`, {
      members: [{ userId: uid['tm'], role: 'agent-maintainer' }],
    });
    expect(again.statusCode, again.body).toBe(204);
    const [kept] = await n.ctx.db.select().from(teamMembers).where(eq(teamMembers.teamId, team));
    expect(kept!.grantChain).toEqual(row!.grantChain);
    await n.ctx.db.delete(teams).where(eq(teams.id, team));
    // the same for the members of an agent
    const agentId = (await newAgent(tok['author']!)).id;
    const members = [{ userId: uid['tm'], role: 'agent-maintainer' }];
    const putAgent = await req(tok['c']!, 'PUT', `/v1/agents/${agentId}/members`, { members });
    expect(putAgent.statusCode, putAgent.body).toBe(204);
    const [bound] = await n.ctx.db
      .select()
      .from(agentRoleBindings)
      .where(eq(agentRoleBindings.agentId, agentId));
    expect(bound!.grantChain).toEqual(expect.arrayContaining([uid['c']]));
    expect(bound!.grantedBy).toBe(uid['c']);
  });
});

describe('finding 4 (second bullet): the identity-provider login keeps who granted a membership', () => {
  it('rewrites the memberships from the group mapping without erasing the grantor of one that stays', async () => {
    const team = j(await req(adminA, 'POST', '/v1/teams', { slug: 'idp-team', name: 'I' })).id;
    const other = j(await req(adminA, 'POST', '/v1/teams', { slug: 'idp-other', name: 'O' })).id;
    const login = () =>
      n.services.identity.upsertExternalUser(
        'ldap',
        'cn=idp-user',
        'idp-user@chain.example.org',
        'I',
        [
          { role: 'agent-maintainer', teamSlug: 'idp-team' },
          { role: 'viewer', teamSlug: 'idp-other' },
        ],
      );
    // the first login lands in the default tenant; move the teams' memberships by hand
    const user = await login();
    await n.ctx.db.update(users).set({ tenantId: orgA }).where(eq(users.id, user.id));
    await n.ctx.db.delete(teamMembers).where(eq(teamMembers.userId, user.id));
    await n.ctx.db.insert(teamMembers).values({
      teamId: team,
      userId: user.id,
      role: 'agent-maintainer',
      grantedBy: uid['c']!,
      grantChain: [uid['c']!, uid['adminA']!],
    });
    await login();
    const rows = await n.ctx.db.select().from(teamMembers).where(eq(teamMembers.userId, user.id));
    const kept = rows.find((r) => r.teamId === team);
    const added = rows.find((r) => r.teamId === other);
    expect(kept).toMatchObject({ grantedBy: uid['c'], grantChain: [uid['c'], uid['adminA']] });
    // a membership the mapping adds is nobody's
    expect(added).toMatchObject({ grantedBy: null, grantorUnknown: false, grantChain: null });
    await n.ctx.db.delete(teams).where(eq(teams.id, team));
    await n.ctx.db.delete(teams).where(eq(teams.id, other));
  });
});

describe('finding 1: a missing chain is unknown', () => {
  it('fails closed on a grantor without a stored chain, and on an unknown creator, unless allowed', async () => {
    await mkUser('nochain', []);
    await grant(adminA, 'nochain', 'agent-maintainer');
    await approves('nochain');
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantChain: null })
      .where(eq(tenantRoleBindings.userId, uid['nochain']!));
    expect(await refusedBy('nochain', 'author')).toBe('binding_grantor_unknown');
    // restored: fine again
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantChain: [uid['adminA']!] })
      .where(eq(tenantRoleBindings.userId, uid['nochain']!));
    await approves('nochain');
    // an account whose creator is not known
    await n.ctx.db.update(users).set({ creatorUnknown: true }).where(eq(users.id, uid['nochain']!));
    expect(await refusedBy('nochain', 'author')).toBe('binding_grantor_unknown');
    const lifecycle = n.ctx.config.lifecycle;
    lifecycle.unknownGrantor = 'allow';
    try {
      await approves('nochain');
    } finally {
      lifecycle.unknownGrantor = 'refuse';
    }
  });
});

describe('finding 2: accounts that lose created_by', () => {
  it('records the creator chain when an account is made, and marks the accounts of a deleted creator when no chain exists', async () => {
    await mkUser('legacy-maker', ['admin']);
    await mkUser('legacy', [], tok['legacy-maker']!);
    const made = (await n.ctx.db.select().from(users).where(eq(users.id, uid['legacy']!)))[0]!;
    expect(made.createdBy).toBe(uid['legacy-maker']);
    expect(made.creatorUnknown).toBe(false);
    expect(made.grantChain).toEqual(expect.arrayContaining([uid['legacy-maker']!, uid['adminA']!]));
    // an account from before the chain existed: creator recorded, chain not
    await n.ctx.db.update(users).set({ grantChain: null }).where(eq(users.id, uid['legacy']!));
    await n.ctx.db.delete(users).where(eq(users.id, uid['legacy-maker']!));
    const lost = (await n.ctx.db.select().from(users).where(eq(users.id, uid['legacy']!)))[0]!;
    expect(lost.createdBy).toBeNull();
    expect(lost.creatorUnknown).toBe(true); // set by the delete trigger, not clean
    expect(creatorChainOf(lost).unknown).toBe(true);
  });

  it('chainForGrant returns undefined for a non-account, a sorted chain for an account and null for an unknown link', async () => {
    expect(await chainForGrant(n.ctx.db, randomUUID(), new Date())).toBeUndefined();
    expect(await chainForGrant(n.ctx.db, null, new Date())).toBeUndefined();
    expect(await chainForGrant(n.ctx.db, 'demo-seed', new Date())).toBeUndefined();
    const chain = await chainForGrant(n.ctx.db, uid['c']!, new Date());
    expect(chain).toEqual(expect.arrayContaining([uid['c']!]));
    expect([...chain!].sort()).toEqual(chain);
    await n.ctx.db.update(users).set({ creatorUnknown: true }).where(eq(users.id, uid['c']!));
    expect(await chainForGrant(n.ctx.db, uid['c']!, new Date())).toBeNull();
    await n.ctx.db.update(users).set({ creatorUnknown: false }).where(eq(users.id, uid['c']!));
  });

  it('follows a chain of six hops and calls a seventh unknown, the line migration 0037 draws too', async () => {
    const ids = Array.from({ length: 9 }, () => randomUUID());
    for (const [i, id] of ids.entries())
      await n.ctx.db.insert(users).values({
        id,
        email: `depth${i}@chain.example.org`,
        displayName: `depth${i}`,
        source: 'local',
        tenantId: orgA,
        createdBy: i === 0 ? null : ids[i - 1]!,
        grantChain: i === 0 ? null : [],
      });
    const walk = (k: number) =>
      followGrantChain(n.ctx.db, [{ userId: ids[k]!, unknown: false }], new Date());
    const six = await walk(6); // ids[6] .. ids[0]: the last one is the sixth hop
    expect(six.unknown).toBe(false);
    expect(six.users).toEqual([...ids.slice(0, 7)].sort());
    expect((await walk(7)).unknown).toBe(true);
    await n.ctx.db.delete(users).where(eq(users.createdBy, ids[0]!)); // clean up the chain
    for (const id of [...ids].reverse()) await n.ctx.db.delete(users).where(eq(users.id, id));
  });

  it('storedChainOf reads the encoding: nobody, known, unknown', () => {
    const a = randomUUID();
    expect(storedChainOf({ grantedBy: null, grantorUnknown: false, grantChain: null })).toEqual({
      users: [],
      unknown: false,
    });
    expect(storedChainOf({ grantedBy: a, grantorUnknown: false, grantChain: null }).unknown).toBe(
      true,
    );
    expect(storedChainOf({ grantedBy: a, grantorUnknown: false, grantChain: [a] })).toEqual({
      users: [a],
      unknown: false,
    });
    expect(storedChainOf({ grantedBy: null, grantorUnknown: true, grantChain: [a] }).unknown).toBe(
      true,
    );
  });
});
