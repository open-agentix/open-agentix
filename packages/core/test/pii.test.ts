import { describe, expect, it } from 'vitest';
import { ibanValid, luhnValid, redactPii } from '../src/pii.js';

// Every value is an example: documentation addresses, test card and IBAN numbers.
describe('personal data redactor (ADR 0012 7.3)', () => {
  it('replaces e-mail addresses', () => {
    const r = redactPii('mail anna.k+test@mail.example.org or bob@sub.example.com now');
    expect(r.text).toBe('mail [pii:email] or [pii:email] now');
    expect(r.counts).toEqual({ email: 2 });
  });

  it('replaces a valid IBAN but not a string that only looks like one', () => {
    expect(redactPii('pay DE89 3704 0044 0532 0130 00 today').text).toBe('pay [pii:iban] today');
    expect(redactPii('GB82WEST12345698765432').text).toBe('[pii:iban]');
    expect(redactPii('DE00 3704 0044 0532 0130 00').counts.iban).toBeUndefined();
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('DE89370400440532013001')).toBe(false);
  });

  it('replaces payment card numbers that pass Luhn, with separators', () => {
    expect(redactPii('card 4111 1111 1111 1111 exp').text).toBe('card [pii:card] exp');
    expect(redactPii('card 5555-5555-5555-4444').text).toBe('card [pii:card]');
    expect(redactPii('order 4111 1111 1111 1112').counts.card).toBeUndefined();
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('replaces IPv4 and IPv6 addresses', () => {
    const r = redactPii('from 203.0.113.9 and 2001:db8::8a2e:370:7334 and ::1');
    expect(r.text).toBe('from [pii:ip] and [pii:ip] and [pii:ip]');
    expect(redactPii('version 1.2.3 build 10.20').text).toBe('version 1.2.3 build 10.20');
  });

  it('replaces phone numbers, not short numbers or dates', () => {
    expect(redactPii('call +49 170 1234567 please').text).toBe('call [pii:phone] please');
    expect(redactPii('call 0170 1234567').text).toBe('call [pii:phone]');
    expect(redactPii('call +1 (415) 555-0132').text).toBe('call [pii:phone]');
    expect(redactPii('ticket 12345 on 2026-10-10 total 42').text).toBe(
      'ticket 12345 on 2026-10-10 total 42',
    );
  });

  it('leaves ordinary text unchanged and returns the same string', () => {
    const t = 'Summarise the incident report and list the open action items.';
    expect(redactPii(t)).toEqual({ text: t, counts: {} });
  });

  it('is linear on hostile input (no catastrophic backtracking)', () => {
    const hostile = [
      'a'.repeat(200_000),
      '1 '.repeat(100_000),
      '1.'.repeat(100_000),
      '@'.repeat(100_000),
      'DE89'.repeat(50_000),
    ];
    for (const h of hostile) {
      const start = Date.now();
      redactPii(h);
      expect(Date.now() - start).toBeLessThan(2000);
    }
  });
});
