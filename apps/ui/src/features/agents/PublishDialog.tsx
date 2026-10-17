import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, call } from '../../api/client';
import { agentReviewsQuery } from '../../api/queries';
import type { Agent, Review } from '../../api/types';
import { ConfirmTenantAction } from '../../components/ConfirmTenantAction';
import { useToast } from '../../components/toast';
import { Badge, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import {
  lifecycleStatus,
  openReviewOf,
  STATUS_LABEL,
  STATUS_TONE,
} from '../reviews/lifecycleStatus';
import { useValidation } from './AgentEditor';
import { DiffView } from './DiffView';
import { publishFailureText } from './publishErrors';

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
  const reviews = useQuery({ ...agentReviewsQuery(agent.id), enabled: open });
  const review = reviews.data ? openReviewOf(reviews.data.items) : null;
  const publish = async () => {
    if (invalid) throw new Error(t('agents.publish.invalid'));
    // Where approval is required the API publishes only under an approved review: name the open
    // review and the revision this dialog shows (the server checks both again under its locks).
    const body = review ? { reviewId: review.id, expectedDigest: review.revision.digest } : null;
    const res = await call(
      api.POST('/v1/agents/{id}/publish', { params: { path: { id: agent.id } }, body }),
    ).catch((e: unknown) => {
      throw new Error(publishFailureText(e, t));
    });
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
    if (res.created) toast.success(t('agents.publish.done', { version: res.version.version }));
    else toast.info(t('agents.publish.unchanged', { version: res.version.version }));
  };
  return (
    <ConfirmTenantAction
      open={open}
      onClose={onClose}
      title={t('agents.publish.title', { name: agent.name })}
      confirmLabel={t('agents.publish.confirm')}
      acknowledge={t('agents.publish.acknowledge')}
      onConfirm={publish}
    >
      <p>{t('agents.publish.text')}</p>
      <ApprovalLine review={review} loading={reviews.isPending && open} />
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
    </ConfirmTenantAction>
  );
}

/** Where the approval stands: the open review's status, or the hint that a review has to be requested. */
function ApprovalLine({
  review,
  loading,
}: {
  review: ReturnType<typeof openReviewOf<Review>>;
  loading: boolean;
}) {
  const t = useT();
  if (loading) return null;
  if (!review)
    return (
      <p className="hint" data-testid="publish-approval">
        {t('agents.publish.approval.noReview')}
      </p>
    );
  const status = lifecycleStatus({ status: 'changed' }, review);
  const counted = review.approvals.filter((a) => a.counted).length;
  return (
    <p data-testid="publish-approval">
      <Badge tone={STATUS_TONE[status]}>{t(STATUS_LABEL[status])}</Badge>{' '}
      <span className="muted">
        {review.approvalRequired
          ? t('agents.publish.approval.required', {
              count: counted,
              required: review.requiredApprovals,
            })
          : t('agents.publish.approval.advisory')}
      </span>
    </p>
  );
}
