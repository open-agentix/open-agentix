import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { parseMarkdown, type Block, type Inline } from './markdown';

/**
 * Renders the Markdown subset of a comment as React elements. There is no `dangerouslySetInnerHTML`
 * and no element created from the text: every string is a text node, so markup in a comment shows
 * as text. Links open in a new tab with `rel="noopener noreferrer nofollow"`, and the host is
 * shown next to the link text so that the text cannot hide where the link goes.
 */

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text':
        return n.value;
      case 'code':
        return (
          <code key={i} className="code-inline">
            {n.value}
          </code>
        );
      case 'strong':
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>;
      case 'link':
        return (
          <span key={i}>
            <a href={n.href} target="_blank" rel="noopener noreferrer nofollow">
              <bdi>{renderInline(n.children)}</bdi>
            </a>
            <span className="md-host">
              {' '}
              (<bdi>{n.host}</bdi>)
            </span>
          </span>
        );
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case 'paragraph':
        return <p key={i}>{renderInline(b.children)}</p>;
      case 'code':
        return (
          <pre key={i} className="code-block" tabIndex={0}>
            <code>{b.value}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.children)}</blockquote>;
      case 'list': {
        const items = b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
    }
  });
}

export function Markdown({ source }: { source: string }) {
  const t = useT();
  const { blocks, truncated } = parseMarkdown(source);
  return (
    <div className="markdown">
      {renderBlocks(blocks)}
      {truncated ? <p className="muted">{t('reviews.markdown.truncated')}</p> : null}
    </div>
  );
}
