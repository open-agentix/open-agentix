import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';
import type { RunStatus } from '../api/types';
import { useT } from '../i18n/i18n';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      className={['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner small /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ small = false, label }: { small?: boolean; label?: string }) {
  return (
    <span
      className={small ? 'spinner spinner-sm' : 'spinner'}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Loading() {
  const t = useT();
  return (
    <div className="loading" role="status">
      <Spinner />
      <span>{t('common.loading')}</span>
    </div>
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  required?: boolean;
}

function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>
        {label}
        {required ? (
          <span className="req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="error-text" id={`${id}-error`}>
          <Icon name="alert" size={14} /> {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return ids || undefined;
}

export function TextField({
  label,
  hint,
  error,
  required,
  id: givenId,
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = givenId ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <input
        id={id}
        className="input"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  id: givenId,
  ...rest
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = givenId ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        className="input textarea"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  id: givenId,
  children,
  ...rest
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const id = givenId ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        className="input select"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<RunStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  awaiting_approval: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  blocked_by_policy: 'danger',
};
const STATUS_ICON: Record<RunStatus, IconName> = {
  queued: 'clock',
  running: 'refresh',
  awaiting_approval: 'hand',
  succeeded: 'check',
  failed: 'alert',
  cancelled: 'stop',
  blocked_by_policy: 'policies',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const t = useT();
  return (
    <span className={`badge badge-${STATUS_TONE[status]}`}>
      <Icon name={STATUS_ICON[status]} size={13} />
      {t(`status.${status}`)}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {back}
        <h1>{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const auto = useId();
  const headingId = `${id ?? auto}-title`;
  return (
    <section
      className={className ? `card ${className}` : 'card'}
      aria-labelledby={title ? headingId : undefined}
      id={id}
    >
      {title || actions ? (
        <div className="card-head">
          {title ? <h2 id={headingId}>{title}</h2> : <span />}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  icon = 'info',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-text">{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const status = error instanceof ApiError ? error.status : 0;
  const title =
    status === 403
      ? t('errors.forbidden')
      : status === 404
        ? t('errors.notFound')
        : status === 0
          ? t('errors.network')
          : t('errors.generic');
  return (
    <div className="empty empty-error" role="alert">
      <span className="empty-icon">
        <Icon name={status === 403 ? 'lock' : 'alert'} size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {error instanceof Error && status !== 403 ? (
        <p className="empty-text">{error.message}</p>
      ) : null}
      {onRetry && status !== 403 ? (
        <Button icon="refresh" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useT();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={label ?? t('common.copy')}
      title={label ?? t('common.copy')}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} />
      <span className="sr-only" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </button>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
}: {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  idPrefix: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = items[(index + delta + items.length) % items.length];
    if (next) {
      onChange(next.key);
      document.getElementById(`${idPrefix}-tab-${next.key}`)?.focus();
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, i) => (
        <button
          key={item.key}
          id={`${idPrefix}-tab-${item.key}`}
          type="button"
          role="tab"
          aria-selected={item.key === value}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={item.key === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(item.key)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  active,
  children,
}: {
  idPrefix: string;
  active: string;
  children: ReactNode;
}) {
  return (
    <div
      id={`${idPrefix}-panel`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-tab-${active}`}
      className="tabpanel"
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={tone ? `stat stat-${tone}` : 'stat'}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub ? <p className="stat-sub">{sub}</p> : null}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'success';
  return (
    <div
      className={`meter meter-${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
    >
      <span style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="code-inline">{children}</code>;
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="code-block" tabIndex={0} aria-label={label}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
