import { afterEach, describe, expect, it } from 'vitest';
import {
  EgressPolicy,
  getEgressPolicy,
  isLoopback,
  parseAllowlist,
  resetEgressPolicy,
  setEgressPolicy,
} from '../src/index.js';

const policy = (allow: string, implicit: string = '') =>
  new EgressPolicy({
    airgapped: true,
    allow: parseAllowlist(allow),
    implicit: parseAllowlist(implicit),
  });

afterEach(() => resetEgressPolicy());

describe('parseAllowlist', () => {
  it('parses hosts, suffixes, ports and CIDRs', () => {
    const e = parseAllowlist(
      'ollama.internal:11434, .corp.example *.svc.cluster.local 10.0.0.0/8 [fd00::1]:443',
    );
    expect(e.map((x) => x.kind)).toEqual(['host', 'suffix', 'suffix', 'cidr', 'host']);
  });

  it('rejects wildcards and malformed entries', () => {
    expect(() => parseAllowlist('*')).toThrow(/wildcard/);
    expect(() => parseAllowlist('0.0.0.0/0')).toThrow(/wildcard/);
    expect(() => parseAllowlist('10.0.0.0/33')).toThrow(/invalid CIDR/);
    expect(() => parseAllowlist('bad$host')).toThrow(/invalid entry/);
    expect(() => parseAllowlist('.x')).toThrow(/invalid suffix/);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe('EgressPolicy', () => {
  it('allows everything when not air-gapped', () => {
    const p = new EgressPolicy({ airgapped: false });
    expect(p.isAllowed('api.openai.com')).toBe(true);
    expect(() => p.assert('https://api.openai.com/v1')).not.toThrow();
  });

  it('denies by default and always allows loopback', () => {
    const p = policy('');
    expect(p.isAllowed('api.anthropic.com', 443)).toBe(false);
    expect(p.isAllowed('localhost')).toBe(true);
    expect(p.isAllowed('127.0.0.1')).toBe(true);
    expect(p.isAllowed('::1')).toBe(true);
    expect(p.isAllowed('[::1]')).toBe(true);
    expect(isLoopback('foo.localhost')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });

  it('matches hosts, suffixes, ports and CIDRs', () => {
    const p = policy('ollama.internal:11434 .corp.example 10.20.0.0/16 fd00::/8 192.168.1.5');
    expect(p.isAllowed('ollama.internal', 11434)).toBe(true);
    expect(p.isAllowed('ollama.internal', 80)).toBe(false);
    expect(p.isAllowed('OLLAMA.internal.', 11434)).toBe(true);
    expect(p.isAllowed('a.b.corp.example')).toBe(true);
    expect(p.isAllowed('corp.example')).toBe(true);
    expect(p.isAllowed('evilcorp.example')).toBe(false);
    expect(p.isAllowed('10.20.255.1')).toBe(true);
    expect(p.isAllowed('10.21.0.1')).toBe(false);
    expect(p.isAllowed('fd12::5')).toBe(true);
    expect(p.isAllowed('fe80::1')).toBe(false);
    expect(p.isAllowed('::ffff:10.20.1.1')).toBe(true);
    expect(p.isAllowed('192.168.1.5')).toBe(true);
    expect(p.isAllowed('192.168.1.6')).toBe(false);
    // a suffix entry never matches a bare IP
    expect(policy('.example').isAllowed('1.2.3.4')).toBe(false);
  });

  it('assert throws egress_denied, records the attempt and knows default ports', () => {
    const p = policy('ok.internal');
    expect(() => p.assert('https://ok.internal/x')).not.toThrow();
    expect(() => p.assert('https://evil.example/x', 'provider')).toThrow(
      /egress_denied|OAX_AIRGAPPED_ALLOW/,
    );
    expect(() => p.assert('ldaps://ldap.evil.example')).toThrow();
    expect(() => p.assert('not a url')).toThrow(/malformed/);
    expect(() => p.assert(new URL('http://evil.example:8080/'))).toThrow();
    expect(p.status()).toEqual({ airgapped: true, allowlist: 1, blocked: 3 });
    expect(p.recorded()[0]).toMatchObject({ host: 'evil.example', port: 443, purpose: 'provider' });
    try {
      p.assertHost('x.example', null);
    } catch (e) {
      expect((e as { code: string }).code).toBe('egress_denied');
    }
  });

  it('implicit entries (database, cache) count without being listed', () => {
    const p = policy('', 'db.internal');
    expect(p.isAllowed('db.internal', 5432)).toBe(true);
    expect(p.status().allowlist).toBe(1);
  });

  it('caps the violation log', () => {
    const p = policy('');
    for (let i = 0; i < 150; i++) p.record(`h${i}.example`, null, 'x');
    expect(p.recorded()).toHaveLength(100);
    expect(p.status().blocked).toBe(150);
  });

  it('keeps a process-wide policy', () => {
    expect(getEgressPolicy().airgapped).toBe(false);
    setEgressPolicy(policy(''));
    expect(getEgressPolicy().airgapped).toBe(true);
    resetEgressPolicy();
    expect(getEgressPolicy().airgapped).toBe(false);
  });
});
