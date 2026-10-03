import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, call } from '../../api/client';
import { agentsQuery, policiesQuery, teamsQuery } from '../../api/queries';
import type { Policy, PolicyEvaluation } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Code,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Section,
  SelectField,
  TextAreaField,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { bundleToForm, formToBundle, invalidPatterns, type BundleForm } from './bundle';

export function PoliciesPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('policies.title'));
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const policies = useQuery(policiesQuery);
  const [editing, setEditing] = useState<Policy | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (p: Policy) =>
      call(
        api.PUT('/v1/policies/{id}', {
          params: { path: { id: p.id } },
          body: { enabled: !p.enabled },
        }),
      ),
    onMutate: async (p) => {
      await queryClient.cancelQueries({ queryKey: policiesQuery.queryKey });
      const previous = queryClient.getQueryData(policiesQuery.queryKey);
      queryClient.setQueryData(policiesQuery.queryKey, (old) =>
        old
          ? { items: old.items.map((x) => (x.id === p.id ? { ...x, enabled: !p.enabled } : x)) }
          : old,
      );
      return { previous };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(policiesQuery.queryKey, ctx.previous);
      toast.error(errorMessage(e));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: policiesQuery.queryKey }),
  });
  return (
    <div className="page">
      <PageHeader
        title={t('policies.title')}
        description={t('policies.subtitle')}
        actions={
          can('policies:write') ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              {t('policies.new')}
            </Button>
          ) : null
        }
      />
      <div className="explain-grid">
        <div className="explain">
          <Icon name="shield" />
          <div>
            <p className="strong">{t('policies.gateTitle')}</p>
            <p className="muted">{t('policies.gateText')}</p>
          </div>
        </div>
        <div className="explain">
          <Icon name="policies" />
          <div>
            <p className="strong">{t('policies.controlTitle')}</p>
            <p className="muted">{t('policies.controlText')}</p>
          </div>
        </div>
      </div>
      <Section title={t('policies.bundles')}>
        {policies.isPending ? (
          <Loading />
        ) : policies.isError ? (
          <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />
        ) : policies.data.items.length === 0 ? (
          <EmptyState icon="policies" title={t('policies.empty')}>
            {t('policies.emptyText')}
          </EmptyState>
        ) : (
          <ul className="cards">
            {policies.data.items.map((p) => {
              const f = bundleToForm(p.bundle);
              return (
                <li key={p.id} className="source-card">
                  <div className="source-head">
                    <span className="strong">{p.name}</span>
                    <Badge tone={p.enabled ? 'success' : 'neutral'}>
                      {p.enabled ? t('common.enabled') : t('common.disabled')}
                    </Badge>
                    <span className="muted">
                      {t('policies.revision', { n: p.version, when: fmt.relative(p.updatedAt) })}
                    </span>
                  </div>
                  {p.description ? <p>{p.description}</p> : null}
                  <RuleList
                    label={t('policies.forbiddenTools')}
                    values={f.forbiddenTools}
                    tone="danger"
                  />
                  <RuleList
                    label={t('policies.forbiddenArgs')}
                    values={f.forbiddenArgPatterns}
                    tone="danger"
                  />
                  <RuleList
                    label={t('policies.requireApproval')}
                    values={f.requireApprovalTools}
                    tone="warning"
                  />
                  {f.maxClassification ? (
                    <p className="copy-row">
                      <span className="muted">{t('policies.maxClassification')}</span>
                      <Badge>
                        {t(`classification.${f.maxClassification}` as 'classification.internal')}
                      </Badge>
                    </p>
                  ) : null}
                  {can('policies:write') ? (
                    <div className="actions">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={() => toggle.mutate(p)}
                        />
                        <span>{t('policies.enabledToggle', { name: p.name })}</span>
                      </label>
                      <Button size="sm" icon="edit" onClick={() => setEditing(p)}>
                        {t('common.edit')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <BudgetsSection />
      {can('agents:read') ? <GateTester /> : null}
      <PolicyDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function RuleList({
  label,
  values,
  tone,
}: {
  label: string;
  values: string;
  tone: 'danger' | 'warning';
}) {
  const items = values.split('\n').filter(Boolean);
  if (!items.length) return null;
  return (
    <div className="rule-list">
      <span className="muted">{label}</span>
      <ul>
        {items.map((v) => (
          <li key={v}>
            <Badge tone={tone}>
              <span className="mono">{v}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BudgetsSection() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const teams = useQuery({ ...teamsQuery, enabled: can('users:read') });
  return (
    <Section title={t('policies.budgets')}>
      <p className="muted">{t('policies.budgetsText')}</p>
      {teams.data?.items.length ? (
        <ul className="list">
          {teams.data.items.map((tm) => (
            <li key={tm.id} className="list-row">
              <span className="list-main">{tm.name}</span>
              <span>
                {tm.monthlyBudgetUsd !== null
                  ? fmt.usd(tm.monthlyBudgetUsd)
                  : t('policies.noBudget')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <Link to="/costs" search={{}} className="inline-link">
        <Icon name="costs" size={16} /> {t('policies.toCosts')}
      </Link>
    </Section>
  );
}

function GateTester() {
  const t = useI18n().t;
  const agents = useQuery(agentsQuery);
  const [agentId, setAgentId] = useState('');
  const [specId, setSpecId] = useState('main');
  const [server, setServer] = useState('');
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');
  const evaluate = useMutation({
    mutationFn: async (): Promise<PolicyEvaluation> => {
      const agent = await call(api.GET('/v1/agents/{id}', { params: { path: { id: agentId } } }));
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(args) as Record<string, unknown>;
      } catch {
        throw new Error(t('policies.tester.invalidJson'));
      }
      return call(
        api.POST('/v1/policies/evaluate', {
          body: {
            source: agent.draftSource,
            agentId: specId,
            call: { server, tool, args: parsed },
          },
        }),
      );
    },
  });
  const result = evaluate.data;
  return (
    <Section title={t('policies.tester.title')}>
      <p className="muted">{t('policies.tester.text')}</p>
      <div className="form-row">
        <SelectField
          label={t('policies.tester.agent')}
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">{t('policies.tester.chooseAgent')}</option>
          {(agents.data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('policies.tester.specId')}
          className="input mono"
          value={specId}
          onChange={(e) => setSpecId(e.target.value)}
        />
        <TextField
          label={t('policies.tester.server')}
          className="input mono"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
        <TextField
          label={t('policies.tester.tool')}
          className="input mono"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
        />
      </div>
      <TextAreaField
        label={t('policies.tester.args')}
        className="input textarea mono"
        rows={4}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
      />
      <div className="actions">
        <Button
          variant="primary"
          icon="shield"
          loading={evaluate.isPending}
          disabled={!agentId || !server || !tool}
          onClick={() => evaluate.mutate()}
        >
          {t('policies.tester.run')}
        </Button>
      </div>
      <div aria-live="polite">
        {evaluate.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(evaluate.error)}
          </p>
        ) : result ? (
          <div className={`verdict verdict-${result.effect}`}>
            <p className="strong">
              <Icon
                name={
                  result.effect === 'allow' ? 'check' : result.effect === 'deny' ? 'close' : 'hand'
                }
              />
              {t(`steps.effects.${result.effect}`)}
            </p>
            {result.reasons.length ? (
              <ul>
                {result.reasons.map((r, i) => (
                  <li key={i}>
                    <Code>{r.code}</Code> {r.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function PolicyDialog({
  editing,
  onClose,
}: {
  editing: Policy | 'new' | null;
  onClose: () => void;
}) {
  const t = useI18n().t;
  const toast = useToast();
  const queryClient = useQueryClient();
  const existing = editing && editing !== 'new' ? editing : null;
  const empty: BundleForm = {
    forbiddenTools: '',
    forbiddenArgPatterns: '',
    requireApprovalTools: '',
    maxClassification: '',
  };
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [form, setForm] = useState<BundleForm>(empty);
  const [opened, setOpened] = useState<typeof editing>(null);
  if (editing !== opened) {
    setOpened(editing);
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setForm(existing ? bundleToForm(existing.bundle) : empty);
  }
  const bad = invalidPatterns(form);
  const save = useMutation({
    mutationFn: () =>
      existing
        ? call(
            api.PUT('/v1/policies/{id}', {
              params: { path: { id: existing.id } },
              body: { description, bundle: formToBundle(form) },
            }),
          )
        : call(
            api.POST('/v1/policies', {
              body: { name: name.trim(), description, bundle: formToBundle(form), enabled: true },
            }),
          ),
    onSuccess: async (p) => {
      await queryClient.invalidateQueries({ queryKey: policiesQuery.queryKey });
      toast.success(t('policies.saved', { name: p.name }));
      onClose();
    },
  });
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      wide
      title={existing ? t('policies.editTitle', { name: existing.name }) : t('policies.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={bad.length > 0 || (!existing && !name.trim())}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!existing ? (
          <TextField
            label={t('policies.name')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <TextField
          label={t('policies.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextAreaField
          label={t('policies.forbiddenTools')}
          hint={t('policies.globHint')}
          className="input textarea mono"
          rows={3}
          value={form.forbiddenTools}
          onChange={(e) => setForm({ ...form, forbiddenTools: e.target.value })}
        />
        <TextAreaField
          label={t('policies.forbiddenArgs')}
          hint={t('policies.patternHint')}
          className="input textarea mono"
          rows={3}
          value={form.forbiddenArgPatterns}
          onChange={(e) => setForm({ ...form, forbiddenArgPatterns: e.target.value })}
          error={bad.length ? t('policies.invalidPattern', { patterns: bad.join(', ') }) : null}
        />
        <TextAreaField
          label={t('policies.requireApproval')}
          hint={t('policies.globHint')}
          className="input textarea mono"
          rows={3}
          value={form.requireApprovalTools}
          onChange={(e) => setForm({ ...form, requireApprovalTools: e.target.value })}
        />
        <SelectField
          label={t('policies.maxClassification')}
          value={form.maxClassification}
          onChange={(e) => setForm({ ...form, maxClassification: e.target.value })}
        >
          <option value="">{t('policies.noLimit')}</option>
          {(['public', 'internal', 'confidential', 'restricted'] as const).map((c) => (
            <option key={c} value={c}>
              {t(`classification.${c}`)}
            </option>
          ))}
        </SelectField>
        {save.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
