import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api, call } from '../../api/client';
import { useToast } from '../../components/toast';
import { Button, ErrorState, Loading, Section, errorMessage } from '../../components/ui';
import { meQuery } from '../../auth/auth';
import { useI18n } from '../../i18n/i18n';
import { activeTenant } from '../../lib/activeTenant';
import { useSwitchableTenants } from '../tenancy/useSwitchableTenants';

const demoQuery = {
  queryKey: ['demo', 'scenarios'],
  queryFn: () => call(api.GET('/v1/demo/scenarios')),
  refetchInterval: 60_000,
};

/** Public demo only: starts one of the fixed scenarios (no free-text input). */
export function DemoScenarios() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const overview = useQuery(demoQuery);
  const { data: me } = useQuery(meQuery);
  const switchable = useSwitchableTenants();
  const chosen = useSyncExternalStore(activeTenant.subscribe, activeTenant.snapshot);
  const actingId = chosen?.id ?? me?.user.tenantId;
  // Scenario runs always land in one fixed tenant (the API decides, never the acting tenant).
  const canOpen = (id: string) => switchable.some((x) => x.id === id) || id === me?.user.tenantId;
  const switchTo = (tenant: { id: string; slug: string; name: string }) => {
    activeTenant.set(tenant);
    toast.success(t('dashboard.demo.tenantSwitched', { tenant: tenant.name }));
  };
  const start = useMutation({
    mutationFn: (scenario: string) =>
      call(api.POST('/v1/demo/scenarios/{scenario}/run', { params: { path: { scenario } } })),
    onSuccess: (res) => {
      toast.success(t('dashboard.demo.started'));
      // Follow the run into the tenant it was created in, when this account may act there.
      if (res.tenant.id !== actingId && canOpen(res.tenant.id)) activeTenant.set(res.tenant);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void navigate({ to: '/runs/$runId', params: { runId: res.runId } });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      void queryClient.invalidateQueries({ queryKey: demoQuery.queryKey });
    },
  });
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const { llm, rateLimit, scenarios, tenant } = overview.data;
  return (
    <Section title={t('dashboard.demo.title')} id="demo-scenarios" tour="demo-scenarios">
      <p className="muted">{t('dashboard.demo.intro')}</p>
      <p className="muted">
        {llm.mode === 'claude-code'
          ? t('dashboard.demo.live', {
              model: llm.model ?? '',
              remaining: fmt.usd(llm.remainingUsd),
            })
          : t('dashboard.demo.simulated')}{' '}
        {t('dashboard.demo.limit', {
          runs: rateLimit.runs,
          minutes: Math.round(rateLimit.windowSeconds / 60),
        })}
      </p>
      {actingId === tenant.id ? (
        <p className="muted">{t('dashboard.demo.tenantNote', { tenant: tenant.name })}</p>
      ) : canOpen(tenant.id) ? (
        <p className="muted">
          {t('dashboard.demo.tenantNote', { tenant: tenant.name })}{' '}
          <Button variant="secondary" size="sm" onClick={() => switchTo(tenant)}>
            {t('dashboard.demo.tenantSwitch', { tenant: tenant.name })}
          </Button>
        </p>
      ) : (
        <p className="notice notice-info" role="note">
          {t('dashboard.demo.tenantLocked', { tenant: tenant.name })}
        </p>
      )}
      <ul className="list">
        {scenarios.map((s) => (
          <li key={s.id} className="list-row">
            <span className="list-main">
              <span className="strong">{s.title}</span>
              <span className="muted">{s.description}</span>
            </span>
            <Button
              variant="primary"
              icon="runs"
              loading={start.isPending && start.variables === s.id}
              disabled={start.isPending}
              onClick={() => start.mutate(s.id)}
            >
              {t('dashboard.demo.run')}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
