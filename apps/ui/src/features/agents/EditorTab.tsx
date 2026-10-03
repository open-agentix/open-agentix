import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, call } from '../../api/client';
import type { Agent } from '../../api/types';
import { useCan } from '../../auth/auth';
import { useToast } from '../../components/toast';
import { Button, Section, errorMessage } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { AgentEditor } from './AgentEditor';
import { PublishDialog } from './PublishDialog';

export function EditorTab({ agent, latestSource }: { agent: Agent; latestSource: string | null }) {
  const t = useT();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [source, setSource] = useState(agent.draftSource);
  const [publishing, setPublishing] = useState(false);
  const dirty = source !== agent.draftSource;
  // Take over server changes when nothing was edited locally.
  useEffect(() => {
    if (!dirty) setSource(agent.draftSource);
  }, [agent.draftSource]);

  const key = ['agents', agent.id];
  const save = useMutation({
    mutationFn: (next: string) =>
      call(
        api.PUT('/v1/agents/{id}/draft', {
          params: { path: { id: agent.id } },
          body: { source: next },
        }),
      ),
    // Optimistic update: the editor shows "saved" immediately, rolled back on error.
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Agent>(key);
      if (previous) {
        queryClient.setQueryData<Agent>(key, {
          ...previous,
          draftSource: next,
          draftUpdatedAt: new Date().toISOString(),
        });
      }
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(t('agents.saveFailed', { message: errorMessage(error) }));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      toast.success(t('agents.saved'));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['agents'], exact: true }),
  });

  const canWrite = can('agents:write');
  return (
    <Section>
      <AgentEditor
        value={source}
        onChange={setSource}
        readOnly={!canWrite}
        label={t('agents.draftLabel')}
      />
      <div className="actions">
        {dirty ? <span className="muted">{t('agents.unsaved')}</span> : null}
        {canWrite ? (
          <>
            <Button variant="ghost" disabled={!dirty} onClick={() => setSource(agent.draftSource)}>
              {t('agents.discard')}
            </Button>
            <Button
              variant="secondary"
              icon="check"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate(source)}
            >
              {t('agents.saveDraft')}
            </Button>
          </>
        ) : null}
        {can('agents:publish') ? (
          <Button
            variant="primary"
            icon="shield"
            disabled={dirty}
            title={dirty ? t('agents.saveBeforePublish') : undefined}
            onClick={() => setPublishing(true)}
          >
            {t('agents.publish.button')}
          </Button>
        ) : null}
      </div>
      {dirty && can('agents:publish') ? (
        <p className="hint">{t('agents.saveBeforePublish')}</p>
      ) : null}
      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        agent={agent}
        latestSource={latestSource}
      />
    </Section>
  );
}
