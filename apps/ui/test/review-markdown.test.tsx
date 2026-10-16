import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n/i18n';
import { Markdown } from '../src/features/reviews/Markdown';
import {
  MAX_MARKDOWN_CHARS,
  parseInline,
  parseMarkdown,
  safeLink,
} from '../src/features/reviews/markdown';

/**
 * The Markdown subset of review comments (ADR 0017 section 9) is the stored-XSS boundary of the
 * review tab: comment text is untrusted tenant content. These tests render hostile payloads into a
 * real DOM and check what can be there, not just what the parser returned.
 */
const ALLOWED_TAGS = new Set([
  'DIV',
  'P',
  'UL',
  'OL',
  'LI',
  'STRONG',
  'EM',
  'CODE',
  'PRE',
  'A',
  'SPAN',
  'BLOCKQUOTE',
]);

function renderMarkdown(source: string) {
  return render(
    <I18nProvider initialLocale="en">
      <Markdown source={source} />
    </I18nProvider>,
  );
}

/** Everything that would make a rendered comment dangerous. */
function expectSafeDom(root: HTMLElement) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    expect(ALLOWED_TAGS.has(el.tagName), `element <${el.tagName.toLowerCase()}>`).toBe(true);
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on'), `attribute ${attr.name}`).toBe(false);
      expect(['src', 'srcdoc', 'style', 'formaction', 'xlink:href'], attr.name).not.toContain(
        attr.name,
      );
    }
  }
  for (const a of Array.from(root.querySelectorAll('a'))) {
    expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
    expect(a.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
    expect(a.getAttribute('target')).toBe('_blank');
  }
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<b onmouseover=alert(1)>x</b>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](  javascript:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](file:///etc/passwd)',
  '[x](//evil.example/x)',
  '[x](/relative)',
  '[x](https://user:pass@evil.example/)',
  '[x](https://a.example/ "title" onmouseover="alert(1)")',
  '[x](https://a.example/"onmouseover="alert(1))',
  '![x](https://evil.example/pixel.png)',
  '![x](javascript:alert(1))',
  '![<img src=x onerror=alert(1)>](https://a.example/x.png)',
  '[<img src=x onerror=alert(1)>](https://a.example/)',
  '[[x](javascript:alert(1))](https://a.example/)',
  '`<script>alert(1)</script>`',
  '```\n<script>alert(1)</script>\n```',
  '> <script>alert(1)</script>',
  '- <img src=x onerror=alert(1)>',
  '**<script>alert(1)</script>**',
  '\\<script>alert(1)\\</script>',
];

describe('safe Markdown rendering', () => {
  it.each(PAYLOADS)('renders %j without a script, image, handler or unsafe link', (payload) => {
    const { container, unmount } = renderMarkdown(payload);
    expectSafeDom(container);
    expect(
      container.querySelector('script, img, iframe, svg, style, object, embed, form'),
    ).toBeNull();
    unmount();
  });

  it('shows raw HTML as text, not as elements', () => {
    const { container } = renderMarkdown('<b>bold?</b> and <script>alert(1)</script>');
    expect(container.textContent).toContain('<b>bold?</b>');
    expect(container.querySelector('b, script')).toBeNull();
  });

  it('turns an http and an https link into an anchor and shows the host', () => {
    const { container } = renderMarkdown(
      'see [the docs](https://docs.example.org/a?b=1) or [plain](http://example.org)',
    );
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://docs.example.org/a?b=1',
      'http://example.org/',
    ]);
    expect(container.textContent).toContain('(docs.example.org)');
    expectSafeDom(container);
  });

  it('shows a refused link and an image as the text that was written', () => {
    const { container } = renderMarkdown(
      '[x](javascript:alert(1)) ![alt](https://a.example/x.png)',
    );
    expect(container.querySelector('a, img')).toBeNull();
    expect(container.textContent).toContain('[x](javascript:alert(1))');
    expect(container.textContent).toContain('![alt](https://a.example/x.png)');
  });

  it('renders the subset: bold, italic, code, lists, quotes and fences', () => {
    const { container } = renderMarkdown(
      'a **bold** and *it* and `code`\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```\nlet x = 1 < 2;\n```',
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('it');
    expect(container.querySelectorAll('code').length).toBe(2);
    expect(container.querySelectorAll('ul > li').length).toBe(2);
    expect(container.querySelectorAll('ol > li').length).toBe(2);
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(container.querySelector('pre code')?.textContent).toBe('let x = 1 < 2;');
    expectSafeDom(container);
  });

  it('leaves snake_case, lone stars and unclosed markers alone', () => {
    const { container } = renderMarkdown('snake_case_name 2 * 3 **open and `tick and [no](');
    expect(container.textContent).toBe('snake_case_name 2 * 3 **open and `tick and [no](');
    expect(container.querySelector('em, strong, a, code')).toBeNull();
  });

  it('honours backslash escapes', () => {
    const { container } = renderMarkdown('\\*not italic\\* and \\[not](https://a.example)');
    expect(container.querySelector('em, a')).toBeNull();
    expect(container.textContent).toBe('*not italic* and [not](https://a.example)');
  });

  it('cuts an overlong comment and says so', () => {
    const { container } = renderMarkdown('a'.repeat(MAX_MARKDOWN_CHARS + 50));
    expect(container.textContent).toContain('The rest of this comment is not shown.');
    expect(container.textContent!.length).toBeLessThan(MAX_MARKDOWN_CHARS + 200);
  });
});

describe('safeLink', () => {
  it.each([
    ['https://example.org', 'example.org'],
    ['http://example.org:8080/a', 'example.org'],
    ['HTTPS://Example.ORG/', 'example.org'],
  ])('accepts %s', (url, host) => {
    expect(safeLink(url)?.host).toBe(host);
  });

  it.each([
    '',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/plain,x',
    'ftp://example.org',
    '//example.org',
    '/path',
    'example.org',
    'https://',
    'https://user@example.org',
    'https://user:pw@example.org',
    'https://exa mple.org',
    'https://example.org/\nnext',
    'https://example.org/\u0000',
    `https://example.org/${'a'.repeat(2100)}`,
  ])('refuses %j', (url) => {
    expect(safeLink(url)).toBeNull();
  });

  it('shows an internationalised host as the browser will connect to it', () => {
    expect(safeLink('https://exаmple.org/')?.host).toBe('xn--exmple-4nf.org');
  });
});

describe('parser limits and speed', () => {
  const adversarial = [
    '*'.repeat(10_000),
    '_'.repeat(10_000),
    '['.repeat(10_000),
    '[a](' + 'b'.repeat(9_990),
    '`'.repeat(10_000),
    '*a '.repeat(3_333),
    '[a]('.repeat(2_000),
    '[['.repeat(5_000) + ']',
    '> '.repeat(5_000),
    '- '.repeat(5_000),
    '1. '.repeat(3_333),
    '```\n'.repeat(2_500),
    '**' + '*'.repeat(9_990),
    '\\'.repeat(10_000),
    '!['.repeat(5_000),
    ('[x](https://a.example/' + 'a'.repeat(30) + ') ').repeat(250),
  ];

  it.each(adversarial.map((s, i) => [i, s] as const))(
    'parses adversarial input %i in linear time',
    (_i, source) => {
      const started = performance.now();
      const parsed = parseMarkdown(source);
      const ms = performance.now() - started;
      expect(parsed.blocks.length).toBeLessThanOrEqual(500);
      expect(ms).toBeLessThan(500);
    },
  );

  it('nests emphasis and quotes only to a fixed depth', () => {
    const deepInline = parseInline('*'.repeat(1) + '**a**'.repeat(1));
    expect(deepInline.length).toBeGreaterThan(0);
    const quotes = parseMarkdown('> > > > > > > deep');
    let depth = 0;
    let node: { kind: string; children?: unknown[] } | undefined = quotes.blocks[0];
    while (node && node.kind === 'quote') {
      depth++;
      node = node.children?.[0] as typeof node;
    }
    expect(depth).toBeLessThanOrEqual(4);
  });

  it('caps the number of blocks and list items', () => {
    const many = parseMarkdown('x\n\n'.repeat(2_000));
    expect(many.blocks.length).toBeLessThanOrEqual(500);
    const items = parseMarkdown('- a\n'.repeat(1_000));
    const list = items.blocks[0];
    expect(list?.kind === 'list' ? list.items.length : 0).toBeLessThanOrEqual(200);
  });
});
