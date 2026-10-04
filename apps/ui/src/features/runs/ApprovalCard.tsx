import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { api, call } from '../../api/client';
import type { Approval } from '../../api/types';
import { useCan } from '../../auth/auth';
import { useToast } from '../../components/toast';
import { Badge, Button, JsonBlock, errorMessage } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId } from '../../lib/hooks';
import { redact } from '../../lib/redact';

export function reasonsText(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons.map((r) =>
    r && typeof r === 'object' && 'message' in r
      ? String((r as { message: unknown }).message)
      : String(r),
  );
}

/** A pending tool call waiting for a human decision. Approve/deny update optimistically. */
export function ApprovalCard({
  approval,
  agentName,
  showRun = false,
}: {
  approval: Approval;
  agentName?: string | undefined;
  showRun?: boolean;
}) {
  const { t, fmt } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const commentId = useId();
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      call(
        api.POST('/v1/approvals/{id}/decision', {
          params: { path: { id: approval.id } },
          body: comment.trim() ? { decision, comment: comment.trim() } : { decision },
        }),
      ),
    onMutate: async () => {
      const key = ['approvals', 'pending'];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{ items: Approval[]; nextCursor: string | null }>(
        key,
      );
      if (previous) {
        queryClient.setQueryData(key, {
          ...previous,
          items: previous.items.filter((a) => a.id !== approval.id),
        });
      }
      return { previous };
    },
    onError: (e, _d, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['approvals', 'pending'], ctx.previous);
      toast.error(errorMessage(e));
    },
    onSuccess: (res) =>
      toast.success(res.status === 'approved' ? t('approvals.approved') : t('approvals.rejected')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['runs', approval.runId] });
    },
  });
  const reasons = reasonsText(approval.reasons);
  return (
    <li className="source-card approval">
      <div className="source-head">
        <span className="strong mono">{approval.tool}</span>
        <Badge tone="warning">{t('status.awaiting_approval')}</Badge>
        {agentName ? <span className="muted">{agentName}</span> : null}
        {showRun ? (
          <Link to="/runs/$runId" params={{ runId: approval.runId }} className="mono">
            #{shortId(approval.runId)}
          </Link>
        ) : null}
      </div>
      {reasons.length ? (
        <ul className="reasons">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
      <JsonBlock value={redact(approval.args)} label={t('approvals.args')} />
      <p className="muted">
        {t('approvals.who', { roles: approval.approverRoles.join(', ') })} ·{' '}
        {t('approvals.expires', { when: fmt.relative(approval.expiresAt) })}
      </p>
      {can('runs:approve') ? (
        <>
          <label htmlFor={commentId} className="sr-only">
            {t('approvals.comment')}
          </label>
          <input
            id={commentId}
            className="input"
            placeholder={t('approvals.comment')}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="actions">
            <Button
              variant="danger"
              icon="close"
              loading={decide.isPending && decide.variables === 'reject'}
              disabled={decide.isPending}
              onClick={() => decide.mutate('reject')}
            >
              {t('approvals.deny')}
            </Button>
            <Button
              variant="primary"
              icon="check"
              loading={decide.isPending && decide.variables === 'approve'}
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              {t('approvals.approve')}
            </Button>
          </div>
        </>
      ) : (
        <p className="muted">{t('approvals.noPermission')}</p>
      )}
    </li>
  );
}
