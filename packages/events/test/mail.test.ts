import { describe, expect, it } from 'vitest';
import { htmlToText, mailToEvent } from '../src/index.js';

describe('mail-in', () => {
  it('normalises mails into events', () => {
    const e = mailToEvent('support', {
      from: 'a@example.com',
      to: 'agent@example.com',
      subject: 'Help',
      text: 'Body',
      messageId: '<m1@x>',
    });
    expect(e).toMatchObject({
      id: '<m1@x>',
      type: 'io.openagentix.mail.received',
      source: '/sources/mail/support',
      subject: 'Help',
      data: {
        from: 'a@example.com',
        to: ['agent@example.com'],
        subject: 'Help',
        body: 'Body',
        date: null,
      },
    });
  });
  it('falls back to html and truncates', () => {
    const e = mailToEvent(
      's',
      {
        from: 'a@b.c',
        to: ['x@y.z'],
        html: '<p>Hi&nbsp;<b>there</b></p><script>x()</script>',
        date: 'd',
      },
      5,
    );
    expect((e.data as { body: string }).body).toBe('Hi th');
    expect((mailToEvent('s', { from: 'a@b.c', to: 'x@y.z' }).data as { body: string }).body).toBe(
      '',
    );
    expect(() => mailToEvent('s', { to: 'x' })).toThrow();
  });
  it('converts html to text', () => {
    expect(htmlToText('a<br>b<div>c</div>&lt;&gt;&amp;<style>p{}</style>\n\n\n\nz')).toBe(
      'a\nbc\n<>&\n\nz',
    );
  });
});
