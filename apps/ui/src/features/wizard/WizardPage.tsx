import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { ROLE_PERMISSIONS } from '../../../../../packages/core/src/rbac';
import { api, call } from '../../api/client';
import { connectionsQuery, eventSourcesQuery, teamsQuery } from '../../api/queries';
import type { Connection } from '../../api/types';
import { settingsQuery, useCan } from '../../auth/auth';
import { Icon, type IconName } from '../../components/Icon';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  CopyButton,
  PageHeader,
  Section,
  SelectField,
  TextAreaField,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useT, type TKey } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { useValidation } from '../agents/AgentEditor';
import {
  generateAgentsMd,
  type OutputFormat,
  type TriggerKind,
  type WizardAnswers,
  type WizardStep,
} from './generate';

const STEPS = ['when', 'do', 'reply', 'review'] as const;
type Step = (typeof STEPS)[number];

const TRIGGERS: { kind: TriggerKind; icon: IconName }[] = [
  { kind: 'webhook', icon: 'events' },
  { kind: 'mail', icon: 'file' },
  { kind: 'kafka', icon: 'model' },
  { kind: 'cron', icon: 'clock' },
  { kind: 'manual', icon: 'runs' },
];
const OUTPUTS: OutputFormat[] = [
  'message',
  'ticket-update',
  'report',
  'pull-request',
  'markdown',
  'json',
];
const CRON_PRESETS = [
  { expr: '0 * * * *', key: 'hourly' },
  { expr: '0 9 * * *', key: 'daily' },
  { expr: '0 8 * * 1-5', key: 'weekdays' },
  { expr: '0 6 * * 1', key: 'weekly' },
] as const;

/** Tool names a connection advertises in its config (`tools: [...]`), if any. */
export function advertisedTools(connection: Connection | undefined): string[] {
  const tools = connection?.config.tools ?? connection?.config.allowedTools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) =>
      typeof t === 'string' ? t : t && typeof t === 'object' && 'name' in t ? String(t.name) : '',
    )
    .filter(Boolean);
}

export function publisherRoles(): string[] {
  return Object.entries(ROLE_PERMISSIONS)
    .filter(([, perms]) => perms.includes('agents:publish'))
    .map(([role]) => role);
}

const emptyStep = (): WizardStep => ({ text: '', server: '', tool: '', approval: false });

export function WizardPage() {
  const t = useT();
  useDocumentTitle(t('wizard.title'));
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery);
  const connections = useQuery({ ...connectionsQuery, enabled: can('connections:read') });
  const sources = useQuery({ ...eventSourcesQuery, enabled: can('sources:read') });
  const teams = useQuery({ ...teamsQuery, enabled: can('users:read') });
  const [step, setStep] = useState<Step>('when');
  const headingId = useId();
  const providers = settings.data?.providers ?? [];
  const [answers, setAnswers] = useState<WizardAnswers>({
    title: '',
    description: '',
    owner: '',
    classification: 'internal',
    trigger: { kind: 'webhook', value: '' },
    steps: [emptyStep()],
    output: { format: 'message', target: '' },
    provider: '',
    model: '',
    maxCostUsd: 0.5,
  });
  const provider =
    answers.provider ||
    providers.find((p) => p.kind === 'simulated')?.name ||
    providers[0]?.name ||
    'simulated';
  const source = useMemo(
    () =>
      generateAgentsMd({
        ...answers,
        provider,
        model: answers.model || (provider === 'simulated' ? 'sim-1' : ''),
      }),
    [answers, provider],
  );
  const validation = useValidation(source, step === 'review');
  const index = STEPS.indexOf(step);
  const update = (patch: Partial<WizardAnswers>) => setAnswers((a) => ({ ...a, ...patch }));
  const updateStep = (i: number, patch: Partial<WizardStep>) =>
    update({ steps: answers.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const create = useMutation({
    mutationFn: () => call(api.POST('/v1/agents', { body: { source } })),
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success(t('wizard.created', { name: agent.name }));
      await navigate({
        to: '/agents/$agentId',
        params: { agentId: agent.id },
        search: { tab: 'editor' },
      });
    },
  });

  const canNext =
    step === 'when'
      ? answers.trigger.kind === 'manual' || answers.trigger.value.trim().length > 0
      : step === 'do'
        ? answers.steps.some((s) => s.text.trim())
        : step === 'reply'
          ? true
          : answers.title.trim().length > 0;

  const go = (next: Step) => {
    setStep(next);
    requestAnimationFrame(() => document.getElementById(headingId)?.focus());
  };

  const webhookSources = (sources.data?.items ?? []).filter((s) => s.kind === answers.trigger.kind);
  const conns = connections.data?.items ?? [];

  let body: ReactNode;
  if (step === 'when') {
    body = (
      <>
        <fieldset className="choice-grid">
          <legend className="sr-only">{t('wizard.when.title')}</legend>
          {TRIGGERS.map((tr) => (
            <label key={tr.kind} className="choice">
              <input
                type="radio"
                name="trigger"
                checked={answers.trigger.kind === tr.kind}
                onChange={() =>
                  update({
                    trigger: {
                      kind: tr.kind,
                      value: tr.kind === 'cron' ? CRON_PRESETS[1].expr : '',
                    },
                  })
                }
              />
              <span className="choice-body">
                <Icon name={tr.icon} />
                <span className="strong">{t(`wizard.triggers.${tr.kind}.label` as TKey)}</span>
                <span className="muted">{t(`wizard.triggers.${tr.kind}.help` as TKey)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {answers.trigger.kind === 'webhook' || answers.trigger.kind === 'mail' ? (
          webhookSources.length ? (
            <SelectField
              label={t('wizard.when.source')}
              value={answers.trigger.value}
              onChange={(e) => update({ trigger: { ...answers.trigger, value: e.target.value } })}
              hint={t('wizard.when.sourceHint')}
            >
              <option value="">{t('wizard.when.chooseSource')}</option>
              {webhookSources.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <TextField
              label={t('wizard.when.sourceName')}
              hint={t('wizard.when.sourceNameHint')}
              value={answers.trigger.value}
              onChange={(e) => update({ trigger: { ...answers.trigger, value: e.target.value } })}
            />
          )
        ) : answers.trigger.kind === 'kafka' ? (
          <TextField
            label={t('wizard.when.topic')}
            value={answers.trigger.value}
            onChange={(e) => update({ trigger: { ...answers.trigger, value: e.target.value } })}
          />
        ) : answers.trigger.kind === 'cron' ? (
          <>
            <fieldset className="radio-row">
              <legend>{t('wizard.when.schedule')}</legend>
              {CRON_PRESETS.map((c) => (
                <label key={c.key} className="radio">
                  <input
                    type="radio"
                    name="cron"
                    checked={answers.trigger.value === c.expr}
                    onChange={() => update({ trigger: { kind: 'cron', value: c.expr } })}
                  />
                  <span>{t(`wizard.cron.${c.key}`)}</span>
                </label>
              ))}
            </fieldset>
            <TextField
              label={t('wizard.when.cronCustom')}
              hint={t('wizard.when.cronHint')}
              className="input mono"
              value={answers.trigger.value}
              onChange={(e) => update({ trigger: { kind: 'cron', value: e.target.value } })}
            />
          </>
        ) : null}
      </>
    );
  } else if (step === 'do') {
    body = (
      <>
        <ol className="wizard-steps">
          {answers.steps.map((s, i) => {
            const conn = conns.find((c) => c.name === s.server);
            const tools = advertisedTools(conn);
            return (
              <li key={i} className="wizard-step">
                <TextAreaField
                  label={t('wizard.do.stepLabel', { n: i + 1 })}
                  placeholder={t('wizard.do.placeholder')}
                  rows={2}
                  value={s.text}
                  onChange={(e) => updateStep(i, { text: e.target.value })}
                />
                <div className="form-row">
                  <SelectField
                    label={t('wizard.do.connection')}
                    value={s.server}
                    onChange={(e) => updateStep(i, { server: e.target.value, tool: '' })}
                    hint={conns.length ? undefined : t('wizard.do.noConnections')}
                  >
                    <option value="">{t('wizard.do.noTool')}</option>
                    {conns.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                  {s.server ? (
                    tools.length ? (
                      <SelectField
                        label={t('wizard.do.tool')}
                        value={s.tool}
                        onChange={(e) => updateStep(i, { tool: e.target.value })}
                      >
                        <option value="">{t('wizard.do.chooseTool')}</option>
                        {tools.map((tool) => (
                          <option key={tool} value={tool}>
                            {tool}
                          </option>
                        ))}
                      </SelectField>
                    ) : (
                      <TextField
                        label={t('wizard.do.tool')}
                        className="input mono"
                        value={s.tool}
                        onChange={(e) => updateStep(i, { tool: e.target.value })}
                      />
                    )
                  ) : null}
                </div>
                {s.server ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={s.approval}
                      onChange={(e) => updateStep(i, { approval: e.target.checked })}
                    />
                    <span>{t('wizard.do.approval')}</span>
                  </label>
                ) : null}
                {answers.steps.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    onClick={() => update({ steps: answers.steps.filter((_, j) => j !== i) })}
                  >
                    {t('wizard.do.remove', { n: i + 1 })}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
        <Button icon="plus" onClick={() => update({ steps: [...answers.steps, emptyStep()] })}>
          {t('wizard.do.add')}
        </Button>
      </>
    );
  } else if (step === 'reply') {
    body = (
      <>
        <fieldset className="choice-grid">
          <legend className="sr-only">{t('wizard.reply.title')}</legend>
          {OUTPUTS.map((format) => (
            <label key={format} className="choice">
              <input
                type="radio"
                name="output"
                checked={answers.output.format === format}
                onChange={() => update({ output: { ...answers.output, format } })}
              />
              <span className="choice-body">
                <Icon name="output" />
                <span className="strong">{t(`wizard.outputs.${format}.label` as TKey)}</span>
                <span className="muted">{t(`wizard.outputs.${format}.help` as TKey)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <TextField
          label={t('wizard.reply.target')}
          hint={t('wizard.reply.targetHint')}
          value={answers.output.target}
          onChange={(e) => update({ output: { ...answers.output, target: e.target.value } })}
        />
      </>
    );
  } else {
    const result = validation.data;
    body = (
      <>
        <div className="form-row">
          <TextField
            label={t('wizard.review.name')}
            required
            value={answers.title}
            onChange={(e) => update({ title: e.target.value })}
            hint={t('wizard.review.nameHint')}
          />
          {teams.data?.items.length ? (
            <SelectField
              label={t('wizard.review.team')}
              value={answers.owner}
              onChange={(e) => update({ owner: e.target.value })}
            >
              <option value="">{t('wizard.review.chooseTeam')}</option>
              {teams.data.items.map((tm) => (
                <option key={tm.id} value={tm.slug}>
                  {tm.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <TextField
              label={t('wizard.review.team')}
              value={answers.owner}
              onChange={(e) => update({ owner: e.target.value })}
            />
          )}
        </div>
        <TextAreaField
          label={t('wizard.review.description')}
          rows={2}
          value={answers.description}
          onChange={(e) => update({ description: e.target.value })}
        />
        <div className="form-row">
          <SelectField
            label={t('wizard.review.classification')}
            value={answers.classification}
            onChange={(e) =>
              update({ classification: e.target.value as WizardAnswers['classification'] })
            }
            hint={t('wizard.review.classificationHint')}
          >
            {(['public', 'internal', 'confidential', 'restricted'] as const).map((c) => (
              <option key={c} value={c}>
                {t(`classification.${c}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('wizard.review.provider')}
            value={provider}
            onChange={(e) => update({ provider: e.target.value })}
          >
            {(providers.length ? providers : [{ name: 'simulated', kind: 'simulated' }]).map(
              (p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.kind})
                </option>
              ),
            )}
          </SelectField>
          <TextField
            label={t('wizard.review.budget')}
            type="number"
            min={0.01}
            step={0.01}
            inputMode="decimal"
            value={answers.maxCostUsd}
            onChange={(e) => update({ maxCostUsd: Number(e.target.value) })}
          />
        </div>
        <div className="approvers">
          <h3>{t('wizard.review.whoApproves')}</h3>
          <ul>
            <li>
              <Icon name="shield" size={16} />{' '}
              {t('wizard.review.publishers', { roles: publisherRoles().join(', ') })}
            </li>
            {answers.steps.some((s) => s.approval) ? (
              <li>
                <Icon name="hand" size={16} />{' '}
                {t('wizard.review.toolApprovers', { roles: 'operator, admin' })}
              </li>
            ) : null}
          </ul>
        </div>
        <details className="preview">
          <summary>
            {t('wizard.review.preview')}{' '}
            {result ? (
              result.valid ? (
                <Badge tone="success">{t('agents.valid')}</Badge>
              ) : (
                <Badge tone="danger">{t('agents.errors', { count: result.errors.length })}</Badge>
              )
            ) : null}
          </summary>
          <div className="preview-bar">
            <CopyButton value={source} label={t('wizard.review.copy')} />
          </div>
          <pre className="code-block" tabIndex={0}>
            {source}
          </pre>
          {result && !result.valid ? (
            <ul className="issues">
              {result.errors.map((e, i) => (
                <li key={i} className="issue issue-error">
                  <span className="mono">{e.path}</span> {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
        {create.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(create.error)}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="page page-narrow">
      <PageHeader title={t('wizard.title')} description={t('wizard.subtitle')} />
      <ol className="stepper" aria-label={t('wizard.progress')}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={i < index ? 'done' : i === index ? 'current' : ''}
            aria-current={i === index ? 'step' : undefined}
          >
            <span className="stepper-n" aria-hidden="true">
              {i < index ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span>{t(`wizard.${s}.short` as TKey)}</span>
          </li>
        ))}
      </ol>
      <Section>
        <h2 id={headingId} tabIndex={-1} className="wizard-q">
          {t(`wizard.${step}.title` as TKey)}
        </h2>
        <p className="muted">{t(`wizard.${step}.help` as TKey)}</p>
        <div className="stack">{body}</div>
        <div className="actions wizard-nav">
          {index > 0 ? (
            <Button variant="ghost" icon="chevronLeft" onClick={() => go(STEPS[index - 1] as Step)}>
              {t('common.back')}
            </Button>
          ) : (
            <Link to="/agents" className="btn btn-ghost btn-md">
              {t('common.cancel')}
            </Link>
          )}
          {step !== 'review' ? (
            <Button
              variant="primary"
              disabled={!canNext}
              onClick={() => go(STEPS[index + 1] as Step)}
            >
              {t('common.next')}
              <Icon name="chevronRight" size={16} />
            </Button>
          ) : can('agents:write') ? (
            <Button
              variant="primary"
              icon="file"
              disabled={!canNext}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('wizard.review.submit')}
            </Button>
          ) : (
            <CopyButton value={source} label={t('wizard.review.copyForEngineer')} />
          )}
        </div>
      </Section>
    </div>
  );
}
