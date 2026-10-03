import { useQuery } from '@tanstack/react-query';
import { useId, useRef, type UIEvent } from 'react';
import { api, call } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Badge, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useDebounced } from '../../lib/hooks';

export function useValidation(source: string, enabled = true) {
  const debounced = useDebounced(source, 400);
  return useQuery({
    queryKey: ['validate', debounced],
    queryFn: ({ signal }) =>
      call(api.POST('/v1/agents/validate', { body: { source: debounced }, signal })),
    enabled: enabled && debounced.trim().length > 0,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
}

/** agents.md editor: monospace textarea with line numbers and live validation by the API. */
export function AgentEditor({
  value,
  onChange,
  readOnly = false,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  label: string;
}) {
  const t = useT();
  const id = useId();
  const gutter = useRef<HTMLDivElement>(null);
  const validation = useValidation(value, !readOnly);
  const lines = value.split('\n').length;
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
  };
  const result = validation.data;
  return (
    <div className="editor-wrap">
      <div className="editor-bar">
        <label htmlFor={id} className="strong">
          {label}
        </label>
        <span aria-live="polite" className="editor-status">
          {readOnly ? (
            <Badge>{t('agents.readOnly')}</Badge>
          ) : validation.isFetching ? (
            <span className="muted">
              <Spinner small /> {t('agents.validating')}
            </span>
          ) : validation.isError ? (
            <Badge tone="warning">{t('agents.validationUnavailable')}</Badge>
          ) : result ? (
            result.valid ? (
              <Badge tone="success">
                <Icon name="check" size={13} />
                {t('agents.valid')}
                {result.version ? ` · v${result.version}` : ''}
              </Badge>
            ) : (
              <Badge tone="danger">
                <Icon name="alert" size={13} />
                {t('agents.errors', { count: result.errors.length })}
              </Badge>
            )
          ) : null}
        </span>
      </div>
      <div className="editor">
        <div className="editor-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          id={id}
          className="editor-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={onScroll}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          aria-describedby={result && !result.valid ? `${id}-issues` : undefined}
          onKeyDown={(e) => {
            // Tab inserts two spaces; Escape then Tab leaves the editor (no keyboard trap).
            if (e.key === 'Tab' && !e.shiftKey && !readOnly && !e.currentTarget.dataset.escaped) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = el;
              const next = `${value.slice(0, s)}  ${value.slice(end)}`;
              onChange(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            } else if (e.key === 'Escape') {
              e.currentTarget.dataset.escaped = '1';
            } else {
              delete e.currentTarget.dataset.escaped;
            }
          }}
        />
      </div>
      {!readOnly ? <p className="hint">{t('agents.editorHint')}</p> : null}
      {result && (result.errors.length > 0 || result.warnings.length > 0) ? (
        <ul className="issues" id={`${id}-issues`}>
          {result.errors.map((e, i) => (
            <li key={`e${i}`} className="issue issue-error">
              <Icon name="alert" size={14} />
              <span className="mono">{e.path || '/'}</span> {e.message}
            </li>
          ))}
          {result.warnings.map((w, i) => (
            <li key={`w${i}`} className="issue issue-warning">
              <Icon name="info" size={14} />
              <span className="mono">{w.path || '/'}</span> {w.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
