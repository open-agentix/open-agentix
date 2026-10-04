import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, call } from '../../api/client';
import { useToast } from '../../components/toast';
import { Button, ErrorState, Loading, Section, errorMessage } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';

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
  const start = useMutation({
    mutationFn: (scenario: string) =>
      call(api.POST('/v1/demo/scenarios/{scenario}/run', { params: { path: { scenario } } })),
    onSuccess: (res) => {
      toast.success(t('dashboard.demo.started'));
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
  const { llm, rateLimit, scenarios } = overview.data;
  return (
    <Section title={t('dashboard.demo.title')} id="demo-scenarios">
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
