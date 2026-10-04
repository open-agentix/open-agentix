import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type ChangeEvent } from 'react';
import { api, call } from '../../api/client';
import type { PlanCheckResult, PlanGenerateResult } from '../../api/types';
import { useCan } from '../../auth/auth';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  PageHeader,
  Section,
  TextAreaField,
  errorMessage,
  type Tone,
} from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { stashAgentDraft } from './draft';

/** Same limit as the API (64 KiB); larger files are refused before they are read. */
export const MAX_PLAN_BYTES = 64 * 1024;

const TONE: Record<'error' | 'warning' | 'info', Tone> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
};

type Lint = NonNullable<PlanCheckResult['lint']>;

function Findings({ lint }: { lint: Lint }) {
  const t = useT();
  const s = lint.summary;
  return (
    <>
      <p className="muted" aria-live="polite">
        {t('plans.summary', { error: s.error, warning: s.warning, info: s.info })}
      </p>
      {lint.findings.length === 0 ? (
        <p>{t('plans.noFindings')}</p>
      ) : (
        <div
          className="table-wrap"
          role="region"
          aria-label={t('common.tableRegion', { name: t('plans.findings') })}
          tabIndex={0}
        >
          <table className="table">
            <thead>
              <tr>
                <th>{t('plans.col.severity')}</th>
                <th>{t('plans.col.code')}</th>
                <th>{t('plans.col.path')}</th>
                <th>{t('plans.col.message')}</th>
                <th>{t('plans.col.source')}</th>
              </tr>
            </thead>
            <tbody>
              {lint.findings.map((f, i) => (
                <tr key={`${f.code}-${f.path}-${i}`}>
                  <td>
                    <Badge tone={TONE[f.severity]}>{t(`plans.severity.${f.severity}`)}</Badge>
                  </td>
                  <td className="mono">{f.code}</td>
                  <td className="mono">{f.path}</td>
                  <td>{f.message}</td>
                  <td>{t(`plans.origin.${f.source}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function PlansPage() {
  const t = useT();
  useDocumentTitle(t('plans.title'));
  const can = useCan();
  const navigate = useNavigate();
  const inputId = useId();
  const [source, setSource] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [checked, setChecked] = useState<PlanCheckResult | null>(null);
  const [generated, setGenerated] = useState<PlanGenerateResult | null>(null);

  const reset = () => {
    setChecked(null);
    setGenerated(null);
  };
  const check = useMutation({
    mutationFn: () => call(api.POST('/v1/plans/check', { body: { source } })),
    onSuccess: (r) => {
      setChecked(r);
      setGenerated(null);
    },
  });
  const generate = useMutation({
    mutationFn: () => call(api.POST('/v1/plans/generate', { body: { source } })),
    onSuccess: (r) => {
      setGenerated(r);
      setChecked(null);
    },
  });

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_PLAN_BYTES) {
      setFileError(t('plans.tooLarge'));
      return;
    }
    setFileError(null);
    setSource(await file.text());
    reset();
  };

  const result = checked ?? generated;
  const lint = result?.lint ?? null;
  const busy = check.isPending || generate.isPending;
  const empty = source.trim().length === 0;

  return (
    <div className="page">
      <PageHeader title={t('plans.title')} description={t('plans.subtitle')} />
      <Section title={t('plans.input')}>
        <TextAreaField
          label={t('plans.source')}
          hint={t('plans.sourceHint')}
          className="input textarea mono"
          rows={16}
          spellCheck={false}
          maxLength={MAX_PLAN_BYTES}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            reset();
          }}
        />
        <div className="actions">
          <label className="btn btn-secondary btn-md" htmlFor={inputId}>
            {t('plans.upload')}
          </label>
          <input
            id={inputId}
            type="file"
            accept=".yaml,.yml,.json,text/plain,application/json"
            className="sr-only"
            onChange={(e) => void onFile(e)}
          />
          <Button
            variant="primary"
            icon="shield"
            loading={check.isPending}
            disabled={empty || busy}
            onClick={() => check.mutate()}
          >
            {t('plans.check')}
          </Button>
          {can('agents:write') ? (
            <Button
              icon="file"
              loading={generate.isPending}
              disabled={empty || busy}
              onClick={() => generate.mutate()}
            >
              {t('plans.generate')}
            </Button>
          ) : null}
        </div>
        {fileError ? (
          <p className="error-text" role="alert">
            {fileError}
          </p>
        ) : null}
        {check.isError || generate.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(check.error ?? generate.error)}
          </p>
        ) : null}
      </Section>

      {result && !result.valid ? (
        <Section title={t('plans.invalid')}>
          <ul className="plain-list" role="alert">
            {result.errors.map((e, i) => (
              <li key={i}>
                <span className="mono">{e.path || '-'}</span>: {e.message}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {lint ? (
        <Section title={t('plans.findings')}>
          <Findings lint={lint} />
          <p className="muted">{t('plans.advisory')}</p>
        </Section>
      ) : null}

      {generated?.valid ? (
        <Section
          title={t('plans.draft')}
          actions={
            generated.draft ? (
              <CopyButton value={generated.draft} label={t('plans.copyDraft')} />
            ) : null
          }
        >
          {generated.draft ? (
            <>
              <p className="muted">{t('plans.draftNote')}</p>
              <pre className="code-block" tabIndex={0} aria-label={t('plans.draftText')}>
                {generated.draft}
              </pre>
              {can('agents:write') ? (
                <div className="actions">
                  <Button
                    variant="primary"
                    icon="plus"
                    onClick={() => {
                      stashAgentDraft(generated.draft ?? '');
                      void navigate({ to: '/agents/new' });
                    }}
                  >
                    {t('plans.openEditor')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState icon="alert" title={t('plans.noDraft')}>
              {t('plans.noDraftText')}
            </EmptyState>
          )}
        </Section>
      ) : null}
    </div>
  );
}
