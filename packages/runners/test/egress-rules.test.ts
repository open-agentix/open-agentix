import { describe, expect, it } from 'vitest';
import {
  assertWithinCeiling,
  classifyAddress,
  normalizeAddress,
  parseEgressEntry,
  parseEgressEntries,
  ruleAllows,
} from '../src/index.js';

describe('egress entry grammar', () => {
  it('parses hosts, ports, suffixes, addresses and CIDRs', () => {
    expect(parseEgressEntry('Jira.Example.com')).toEqual({
      kind: 'host',
      host: 'jira.example.com',
      port: null,
    });
    expect(parseEgressEntry('jira.example.com:8443')).toMatchObject({ port: 8443 });
    expect(parseEgressEntry('*.example.com')).toEqual({
      kind: 'suffix',
      suffix: 'example.com',
      port: null,
    });
    expect(parseEgressEntry('203.0.113.7')).toMatchObject({ kind: 'cidr' });
    expect(parseEgressEntry('203.0.113.0/24')).toMatchObject({ kind: 'cidr' });
    expect(parseEgressEntry('2001:db8::/48')).toMatchObject({ kind: 'cidr' });
    expect(parseEgressEntry('[2001:db8::1]:8443')).toEqual({
      kind: 'host',
      host: '2001:db8::1',
      port: 8443,
    });
    expect(parseEgressEntries(['a.example.com', 'b.example.com'])).toHaveLength(2);
  });
  it.each([
    '',
    '*',
    '*.com',
    '*.',
    '.example.com',
    'a b',
    'a_b.example.com',
    '0.0.0.0/0',
    '0.0.0.0/1',
    '128.0.0.0/1',
    '10.0.0.0/7',
    '::/0',
    '2000::/3',
    'example.com:0',
    'example.com:99999',
    'example.com:x',
    '999.1.1.1',
    'x'.repeat(260),
    '203.0.113.0/33',
    'http://example.com',
  ])('refuses %j', (entry) => {
    expect(() => parseEgressEntry(entry)).toThrow(/egress|CIDR|address/);
  });
});

describe('operator ceiling', () => {
  const ceiling = parseEgressEntries([
    '*.example.com',
    'api.example.org:8443',
    '203.0.113.0/24',
    'exact.example.net',
  ]);
  it('accepts only what is covered (intersection)', () => {
    expect(
      assertWithinCeiling(
        [
          'a.example.com',
          'x.y.example.com',
          '*.sub.example.com',
          '203.0.113.5',
          '203.0.113.128/25',
          'api.example.org:8443',
          'exact.example.net',
        ],
        ceiling,
      ),
    ).toHaveLength(7);
  });
  it.each([
    'example.com',
    'evil.com',
    'a.example.com.evil.com',
    '*.example.com.evil.com',
    '*.com',
    'api.example.org',
    'api.example.org:443',
    '203.0.112.0/24',
    '203.0.0.0/8',
    '10.0.0.0/8',
    'sub.exact.example.net',
    '*.example.net',
    '8.8.8.8',
  ])('refuses %s', (entry) => {
    expect(() => assertWithinCeiling([entry], ceiling)).toThrow(
      /outside the operator egress allowlist|too broad|egress/,
    );
  });
  it('an empty ceiling allows no entry', () => {
    expect(() => assertWithinCeiling(['a.example.com'], [])).toThrow(/outside/);
    expect(assertWithinCeiling([], [])).toEqual([]);
  });
});

describe('address classification', () => {
  it.each([
    ['93.184.216.34', 'ok'],
    ['8.8.8.8', 'ok'],
    ['2606:2800:220:1::1', 'ok'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.17.0.1', 'private'],
    ['192.168.0.1', 'private'],
    ['100.64.0.1', 'private'],
    ['198.18.0.1', 'private'],
    ['198.19.255.255', 'private'],
    ['0.0.0.0', 'private'],
    ['224.0.0.1', 'private'],
    ['255.255.255.255', 'private'],
    ['fc00::1', 'private'],
    ['fd12::1', 'private'],
    ['64:ff9b::808:808', 'private'],
    ['2002:808:808::1', 'private'],
    ['ff02::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:93.184.216.34', 'ok'],
    ['127.0.0.1', 'denied'],
    ['127.255.0.1', 'denied'],
    ['::1', 'denied'],
    ['169.254.169.254', 'denied'],
    ['fe80::1', 'denied'],
    ['fd00:ec2::254', 'denied'],
    ['168.63.129.16', 'denied'],
    ['100.100.100.200', 'denied'],
    ['::ffff:127.0.0.1', 'denied'],
    ['::ffff:a9fe:a9fe', 'denied'],
    ['64:ff9b::7f00:1', 'denied'],
    ['not-an-ip', 'denied'],
    ['', 'denied'],
  ])('%s -> %s', (addr, expected) => {
    expect(classifyAddress(addr)).toBe(expected);
  });
  it('normalises IPv4-mapped forms and brackets', () => {
    expect(normalizeAddress('::ffff:1.2.3.4')?.version).toBe(4);
    expect(normalizeAddress('::ffff:102:304')?.version).toBe(4);
    expect(normalizeAddress('0:0:0:0:0:ffff:102:304')?.version).toBe(4);
    expect(normalizeAddress('::ffff:0:102:304')?.version).toBe(4);
    expect(normalizeAddress('::102:304')?.version).toBe(4);
    expect(normalizeAddress('::1')?.version).toBe(4); // numeric low bits; classification stays "denied"
    expect(normalizeAddress('::ffff:999.1.1.1')).toBeUndefined();
    expect(normalizeAddress('[2001:db8::1]')?.version).toBe(6);
    expect(normalizeAddress('fe80::1%eth0')?.version).toBe(6);
  });
});

describe('rule matching', () => {
  const addr = normalizeAddress('203.0.113.5');
  it('matches by kind with the default port 443', () => {
    expect(ruleAllows(parseEgressEntry('a.example.com'), 'a.example.com', undefined, 443)).toBe(
      true,
    );
    expect(ruleAllows(parseEgressEntry('a.example.com'), 'a.example.com', undefined, 80)).toBe(
      false,
    );
    expect(ruleAllows(parseEgressEntry('a.example.com:80'), 'a.example.com', undefined, 80)).toBe(
      true,
    );
    expect(ruleAllows(parseEgressEntry('*.example.com'), 'x.example.com', undefined, 443)).toBe(
      true,
    );
    expect(ruleAllows(parseEgressEntry('*.example.com'), 'example.com', undefined, 443)).toBe(
      false,
    );
    expect(ruleAllows(parseEgressEntry('*.example.com'), 'x.example.com', addr, 443)).toBe(false);
    expect(ruleAllows(parseEgressEntry('203.0.113.0/24'), '203.0.113.5', addr, 443)).toBe(true);
    expect(ruleAllows(parseEgressEntry('203.0.113.0/24'), '203.0.113.5', addr, 80)).toBe(false);
    expect(ruleAllows(parseEgressEntry('203.0.113.0/24'), 'name', undefined, 443)).toBe(false);
  });
});
