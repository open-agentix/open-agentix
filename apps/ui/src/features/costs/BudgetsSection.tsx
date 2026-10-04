import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, call } from '../../api/client';
import { budgetsQuery } from '../../api/queries';
import type { BudgetLine } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import { Badge, Button, Meter, Section, TextField, errorMessage } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';

/** Highest alert threshold raised this month (50, 80 or 100) or null. */
export const topAlert = (line: Pick<BudgetLine, 'alerts'>): number | null =>
  line.alerts.length ? Math.max(...line.alerts) : null;

/** Monthly tenant and use case budgets with hard-stop status; admins manage use case limits. */
export function BudgetsSection() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const budgets = useQuery(budgetsQuery);
  const [useCase, setUseCase] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: budgetsQuery.queryKey });
  const save = useMutation({
    mutationFn: () =>
      call(
        api.PUT('/v1/budgets/use-cases/{useCase}', {
          params: { path: { useCase: useCase.trim() } },
          body: { monthlyBudgetUsd: Number(limit) },
        }),
      ),
    onSuccess: async () => {
      await refresh();
      toast.success(t('costs.budgetSaved', { useCase: useCase.trim() }));
      setUseCase('');
      setLimit('');
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      call(api.DELETE('/v1/budgets/use-cases/{useCase}', { params: { path: { useCase: name } } })),
    onSuccess: async (_d, name) => {
      await refresh();
      toast.success(t('costs.budgetRemoved', { useCase: name }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!budgets.data) return null;
  const { tenant, useCases } = budgets.data;
  const lines = [...(tenant.limitUsd === null ? [] : [tenant]), ...useCases];
  const admin = can('settings:write');
  if (!lines.length && !admin) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!useCase.trim() || limit === '' || Number(limit) < 0) {
      setError(t('costs.budgetInvalid'));
      return;
    }
    save.mutate();
  };
  return (
    <Section title={t('costs.monthlyBudgets')}>
      <p className="muted">{t('costs.monthlyBudgetsText')}</p>
      <ul className="list">
        {lines.map((line) => {
          const name = line.scope === 'tenant' ? t('costs.tenantBudget') : (line.key ?? '');
          const alert = topAlert(line);
          return (
            <li key={`${line.scope}:${line.key}`} className="budget-row">
              <span className="strong">{name}</span>
              <Meter
                value={line.spentUsd}
                max={line.limitUsd ?? 0}
                label={t('costs.budgetOf', { team: name })}
              />
              <span>
                {fmt.usd(line.spentUsd)} / {fmt.usd(line.limitUsd ?? 0)}
              </span>
              {alert === 100 ? (
                <Badge tone="danger">
                  <Icon name="alert" size={13} /> {t('costs.stopped')}
                </Badge>
              ) : alert !== null ? (
                <Badge tone="warning">
                  <Icon name="alert" size={13} /> {t('costs.alertAt', { percent: alert })}
                </Badge>
              ) : (
                <Badge tone="success">{t('costs.onTrack')}</Badge>
              )}
              {line.scope === 'use_case' && admin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={remove.isPending && remove.variables === line.key}
                  onClick={() => remove.mutate(line.key ?? '')}
                  aria-label={t('costs.removeBudget', { useCase: name })}
                >
                  {t('common.delete')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {admin ? (
        <form className="row" onSubmit={submit} noValidate>
          <TextField
            label={t('costs.useCase')}
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
          />
          <TextField
            label={t('costs.monthlyLimit')}
            type="number"
            min="0"
            step="0.01"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            error={error}
          />
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('costs.setBudget')}
          </Button>
        </form>
      ) : null}
    </Section>
  );
}
