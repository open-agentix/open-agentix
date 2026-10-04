import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, call } from '../../api/client';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import { Button, EmptyState, PageHeader, Section, errorMessage } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { takeAgentDraft } from '../plans/draft';
import { AgentEditor } from './AgentEditor';
import { AGENT_TEMPLATE } from './template';

export function NewAgentPage() {
  const t = useT();
  useDocumentTitle(t('agents.new'));
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [source, setSource] = useState(() => takeAgentDraft() ?? AGENT_TEMPLATE);
  const create = useMutation({
    mutationFn: () => call(api.POST('/v1/agents', { body: { source } })),
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success(t('agents.created', { name: agent.name }));
      await navigate({
        to: '/agents/$agentId',
        params: { agentId: agent.id },
        search: { tab: 'editor' },
      });
    },
  });
  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/agents" className="back">
            <Icon name="chevronLeft" size={16} /> {t('agents.title')}
          </Link>
        }
        title={t('agents.new')}
        description={t('agents.newSubtitle')}
      />
      {can('agents:write') ? (
        <Section>
          <AgentEditor value={source} onChange={setSource} label="agents.md" />
          {create.isError ? (
            <p className="error-text" role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
          <div className="actions">
            <Button
              variant="primary"
              icon="plus"
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('agents.createDraft')}
            </Button>
          </div>
        </Section>
      ) : (
        <EmptyState icon="lock" title={t('errors.forbidden')} />
      )}
    </div>
  );
}
