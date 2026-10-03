import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, call } from '../../api/client';
import type { Agent, AgentVersion, AgentVersionDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import {
  Button,
  EmptyState,
  Section,
  SelectField,
  TextAreaField,
  errorMessage,
} from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { readDefinition } from './definition';

export function exampleEvent(latest: AgentVersionDetail | undefined): string {
  const trigger = latest ? readDefinition(latest.definition).triggers[0] : undefined;
  const example =
    trigger?.type === 'webhook' || trigger?.type === 'mail'
      ? { source: trigger.detail, subject: 'TEST-1', text: 'Example event for a test run' }
      : trigger?.type === 'kafka'
        ? { topic: trigger.detail, key: 'example', value: { hello: 'world' } }
        : { message: 'Example event for a test run' };
  return JSON.stringify(example, null, 2);
}

export function TestRunTab({
  agent,
  versions,
  latest,
}: {
  agent: Agent;
  versions: AgentVersion[];
  latest: AgentVersionDetail | undefined;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [version, setVersion] = useState(agent.latestVersion ?? '');
  const [payload, setPayload] = useState(() => exampleEvent(latest));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const providers = latest
    ? [...new Set(readDefinition(latest.definition).agents.map((a) => a.provider))]
    : [];
  const simulated = providers.length > 0 && providers.every((p) => p === 'simulated');
  const start = useMutation({
    mutationFn: (data: unknown) =>
      call(
        api.POST('/v1/agents/{id}/runs', {
          params: { path: { id: agent.id } },
          body: { data, version },
        }),
      ),
    onSuccess: (run) => navigate({ to: '/runs/$runId', params: { runId: run.id } }),
  });
  if (!versions.length) {
    return (
      <Section>
        <EmptyState icon="runs" title={t('agents.test.needsVersion')}>
          {t('agents.test.needsVersionText')}
        </EmptyState>
      </Section>
    );
  }
  const submit = () => {
    try {
      const data: unknown = JSON.parse(payload);
      setJsonError(null);
      start.mutate(data);
    } catch {
      setJsonError(t('agents.test.invalidJson'));
    }
  };
  return (
    <Section title={t('agents.test.title')}>
      <p className={simulated ? 'notice notice-info' : 'notice notice-warning'}>
        <Icon name={simulated ? 'info' : 'alert'} size={16} />
        {simulated
          ? t('agents.test.simulated')
          : t('agents.test.realProvider', { providers: providers.join(', ') || '?' })}
      </p>
      <SelectField
        label={t('agents.test.version')}
        value={version}
        onChange={(e) => setVersion(e.target.value)}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.version}>
            v{v.version}
          </option>
        ))}
      </SelectField>
      <TextAreaField
        label={t('agents.test.event')}
        hint={t('agents.test.eventHint')}
        className="input textarea mono"
        rows={10}
        value={payload}
        error={jsonError}
        onChange={(e) => setPayload(e.target.value)}
        spellCheck={false}
      />
      {start.isError ? (
        <p className="error-text" role="alert">
          {errorMessage(start.error)}
        </p>
      ) : null}
      <div className="actions">
        <Button variant="primary" icon="runs" loading={start.isPending} onClick={submit}>
          {t('agents.test.start')}
        </Button>
      </div>
    </Section>
  );
}
