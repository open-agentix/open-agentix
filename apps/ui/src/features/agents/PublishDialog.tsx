import { useQueryClient } from '@tanstack/react-query';
import { api, call } from '../../api/client';
import type { Agent } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toast';
import { Badge, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useValidation } from './AgentEditor';
import { DiffView } from './DiffView';

/** Publishing creates an immutable version: show validation + diff and require confirmation. */
export function PublishDialog({
  open,
  onClose,
  agent,
  latestSource,
}: {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  latestSource: string | null;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const validation = useValidation(agent.draftSource, open);
  const result = validation.data;
  const invalid = !!result && !result.valid;
  const publish = async () => {
    if (invalid) throw new Error(t('agents.publish.invalid'));
    const res = await call(
      api.POST('/v1/agents/{id}/publish', { params: { path: { id: agent.id } } }),
    );
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
    if (res.created) toast.success(t('agents.publish.done', { version: res.version.version }));
    else toast.info(t('agents.publish.unchanged', { version: res.version.version }));
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={t('agents.publish.title', { name: agent.name })}
      confirmLabel={t('agents.publish.confirm')}
      acknowledge={t('agents.publish.acknowledge')}
      onConfirm={publish}
    >
      <p>{t('agents.publish.text')}</p>
      <p>
        {validation.isPending && open ? (
          <span className="muted">
            <Spinner small /> {t('agents.validating')}
          </span>
        ) : result ? (
          result.valid ? (
            <Badge tone="success">
              {t('agents.publish.willPublish', { version: result.version ?? '?' })}
            </Badge>
          ) : (
            <Badge tone="danger">{t('agents.errors', { count: result.errors.length })}</Badge>
          )
        ) : null}
      </p>
      {latestSource !== null ? (
        <DiffView
          before={latestSource}
          after={agent.draftSource}
          label={t('agents.publish.diffLabel')}
        />
      ) : (
        <p className="muted">{t('agents.publish.first')}</p>
      )}
    </ConfirmDialog>
  );
}
