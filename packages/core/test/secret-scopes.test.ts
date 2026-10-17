import { describe, expect, it } from 'vitest';
import {
  CredentialRefSchema,
  destinationAllowed,
  destinationsAllowed,
  matchNameGlob,
  nameBlocked,
  nearestTenantSecret,
  parseDestinations,
  parseNameGlobs,
  parseSecretRef,
  secretResolutionDigest,
  secretResolutionDigestOf,
  type ChainNode,
  type SecretPin,
} from '../src/index.js';

describe('parseSecretRef', () => {
  it('keeps unprefixed references legacy', () => {
    expect(parseSecretRef('acme.db-password')).toEqual({ kind: 'legacy', ref: 'acme.db-password' });
    expect(parseSecretRef('Team')).toEqual({ kind: 'legacy', ref: 'Team' });
  });

  it('reads the prefix as the scope', () => {
    expect(parseSecretRef('team:jira-token')).toMatchObject({ scope: 'team', name: 'jira-token' });
    expect(parseSecretRef('tenant:a.b')).toMatchObject({ scope: 'tenant', name: 'a.b' });
    expect(parseSecretRef('personal:x1')).toMatchObject({ scope: 'personal' });
  });

  it.each(['Team:x', 'group:x', 'team:', 'team:UP', 'team:a:b', ':x', 'tenant: x', 'team:-x'])(
    'refuses the malformed reference %s instead of reading it as legacy',
    (ref) => {
      expect(parseSecretRef(ref)).toBeNull();
    },
  );

  it('is accepted by the agent schema only in the well-formed spellings', () => {
    const ok = (secret: string) => CredentialRefSchema.safeParse({ secret }).success;
    expect(ok('team:jira-token')).toBe(true);
    expect(ok('legacy-name')).toBe(true);
    expect(ok('Team:jira')).toBe(false);
    expect(ok('team:Jira')).toBe(false);
    expect(ok('a:b')).toBe(false);
  });
});

describe('name globs', () => {
  it('matches with * only', () => {
    expect(matchNameGlob('jira-*', 'jira-token')).toBe(true);
    expect(matchNameGlob('jira-*', 'jira-')).toBe(true);
    expect(matchNameGlob('*-token', 'jira-token')).toBe(true);
    expect(matchNameGlob('a*c*e', 'abcde')).toBe(true);
    expect(matchNameGlob('a*c*e', 'ae')).toBe(false);
    expect(matchNameGlob('abc', 'abcd')).toBe(false);
    expect(matchNameGlob('a.c', 'abc')).toBe(false);
    expect(nameBlocked(['x', 'y-*'], 'y-1')).toBe(true);
    expect(nameBlocked([], 'y-1')).toBe(false);
  });

  it('validates the list', () => {
    expect(parseNameGlobs(['b', 'a', 'a'])).toEqual(['a', 'b']);
    expect(parseNameGlobs(['UP'])).toBeNull();
    expect(parseNameGlobs('a')).toBeNull();
    expect(parseNameGlobs(Array.from({ length: 65 }, (_, i) => `n${i}`))).toBeNull();
  });
});

describe('destinations', () => {
  it('accepts hosts and suffix patterns only', () => {
    expect(parseDestinations(['b.example.org', '*.example.org'])).toEqual([
      '*.example.org',
      'b.example.org',
    ]);
    for (const bad of [['*'], ['10.0.0.1'], ['a.org:443'], ['*.*.org'], ['A.org'], [''], 'x'])
      expect(parseDestinations(bad)).toBeNull();
  });

  it('judges an egress entry of a step', () => {
    const p = ['api.example.org', '*.corp.example'];
    expect(destinationAllowed(p, 'api.example.org')).toBe(true);
    expect(destinationAllowed(p, 'API.example.org:443')).toBe(true);
    expect(destinationAllowed(p, 'evil.example.org')).toBe(false);
    expect(destinationAllowed(p, 'x.corp.example')).toBe(true);
    expect(destinationAllowed(p, 'corp.example')).toBe(false);
    expect(destinationAllowed(p, 'notcorp.example')).toBe(false);
    // a suffix entry is inside only a wider or equal suffix pattern
    expect(destinationAllowed(p, '*.corp.example')).toBe(true);
    expect(destinationAllowed(p, '*.a.corp.example')).toBe(true);
    expect(destinationAllowed(p, '*.example')).toBe(false);
    expect(destinationAllowed(['api.example.org'], '*.example.org')).toBe(false);
    // addresses never pass
    expect(destinationAllowed(p, '10.0.0.0/8')).toBe(false);
    expect(destinationAllowed(p, '10.0.0.1')).toBe(false);
    expect(destinationAllowed([], 'api.example.org')).toBe(false);
  });

  it('allows a step without any destination', () => {
    expect(destinationsAllowed([], [])).toBe(true);
    expect(destinationsAllowed(['a.org'], ['a.org', 'b.org'])).toBe(false);
  });
});

describe('nearestTenantSecret', () => {
  const chain = (...ids: [string, string[]?][]): ChainNode[] =>
    ids.map(([id, b]) => ({ id, blockInherited: b ?? [] }));
  const c = (ownerId: string, inherit = true) => ({ ownerId, inherit });

  it('picks the nearest owner', () => {
    const picked = nearestTenantSecret(chain(['m'], ['p'], ['r']), [c('r'), c('p')], 'x');
    expect(picked?.ownerId).toBe('p');
  });

  it('does not use a secret of a descendant, a sibling or no owner on the chain', () => {
    expect(nearestTenantSecret(chain(['m'], ['r']), [c('child'), c('sibling')], 'x')).toBeNull();
  });

  it('keeps an inherit:false secret node-only', () => {
    expect(nearestTenantSecret(chain(['m'], ['r']), [c('r', false)], 'x')).toBeNull();
    expect(nearestTenantSecret(chain(['r']), [c('r', false)], 'x')?.ownerId).toBe('r');
    // a node-only secret of the parent does not stop the search at the grandparent
    expect(
      nearestTenantSecret(chain(['m'], ['p'], ['r']), [c('p', false), c('r')], 'x')?.ownerId,
    ).toBe('r');
  });

  it('lets blockInherited hide names owned above, not the own or lower ones', () => {
    const ch = chain(['m'], ['p', ['x']], ['r']);
    expect(nearestTenantSecret(ch, [c('r')], 'x')).toBeNull();
    expect(nearestTenantSecret(ch, [c('p')], 'x')?.ownerId).toBe('p');
    expect(nearestTenantSecret(ch, [c('m'), c('r')], 'x')?.ownerId).toBe('m');
    expect(nearestTenantSecret(ch, [c('r')], 'other')?.ownerId).toBe('r');
    // blocking at the node of the agent itself hides everything inherited
    expect(nearestTenantSecret(chain(['m', ['*']], ['r']), [c('r')], 'x')).toBeNull();
  });

  it('returns a nearer revoked-looking candidate instead of falling back', () => {
    // existence wins; the caller decides on revoked/expired and fails closed
    expect(nearestTenantSecret(chain(['m'], ['r']), [c('m'), c('r')], 'x')?.ownerId).toBe('m');
  });
});

describe('secret resolution digest', () => {
  const legacy = (ref: string): SecretPin => ({ ref, state: 'legacy' });
  const resolved = (ref: string, ownerNode: string, secretId: string): SecretPin => ({
    ref,
    state: 'resolved',
    scope: 'tenant',
    ownerNode,
    secretId,
  });

  it('is byte-compatible with the names-only digest without scoped references', () => {
    expect(secretResolutionDigestOf([legacy('b'), legacy('a')])).toBe(
      secretResolutionDigest(['a', 'b']),
    );
    expect(secretResolutionDigestOf([])).toBe(secretResolutionDigest([]));
  });

  it('binds to the owning node and the secret id', () => {
    const a = secretResolutionDigestOf([resolved('tenant:x', 'n1', 's1')]);
    expect(secretResolutionDigestOf([resolved('tenant:x', 'n1', 's1')])).toBe(a);
    expect(secretResolutionDigestOf([resolved('tenant:x', 'n2', 's2')])).not.toBe(a);
    expect(secretResolutionDigestOf([resolved('tenant:x', 'n1', 's2')])).not.toBe(a);
    expect(
      secretResolutionDigestOf([
        { ref: 'tenant:x', state: 'unresolved', code: 'secret_not_found' },
      ]),
    ).not.toBe(a);
    expect(a).not.toBe(secretResolutionDigest(['tenant:x']));
  });

  it('is independent of the order and of duplicates', () => {
    const x = resolved('tenant:x', 'n', 's');
    const y = legacy('y');
    expect(secretResolutionDigestOf([x, y, x])).toBe(secretResolutionDigestOf([y, x]));
  });
});
