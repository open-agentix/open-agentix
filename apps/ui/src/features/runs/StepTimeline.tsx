import type { RunStep } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Badge, JsonBlock, type Tone } from '../../components/ui';
import { useI18n, type TKey } from '../../i18n/i18n';
import { redact } from '../../lib/redact';
import { reasonsText } from './ApprovalCard';

const KIND_ICON: Record<string, IconName> = {
  model_call: 'model',
  tool_call: 'tool',
  policy_decision: 'shield',
  approval: 'hand',
  control: 'policies',
  output: 'output',
  error: 'alert',
};

const STATUS_TONE: Record<string, Tone> = {
  ok: 'success',
  approved: 'success',
  error: 'danger',
  denied: 'danger',
  rejected: 'danger',
  pending: 'warning',
};

export function policyOutcome(step: RunStep): { effect: string; reasons: string[] } | null {
  if (step.kind !== 'policy_decision' || !step.output || typeof step.output !== 'object')
    return null;
  const out = step.output as { effect?: unknown; reasons?: unknown };
  return { effect: String(out.effect ?? step.status), reasons: reasonsText(out.reasons) };
}

export function StepTimeline({ steps }: { steps: RunStep[] }) {
  const { t, fmt } = useI18n();
  return (
    <ol className="timeline steps">
      {steps.map((s) => {
        const policy = policyOutcome(s);
        const tone = STATUS_TONE[s.status] ?? 'neutral';
        return (
          <li key={s.seq} className={`timeline-item step step-${tone}`}>
            <div className="timeline-dot" aria-hidden="true">
              <Icon name={KIND_ICON[s.kind] ?? 'info'} size={14} />
            </div>
            <div className="timeline-body">
              <p className="step-head">
                <span className="strong">{t(`steps.kinds.${s.kind}` as TKey) || s.kind}</span>
                <span className="mono">{s.name}</span>
                <Badge tone={tone}>{t(`steps.status.${s.status}` as TKey)}</Badge>
                {s.agentId ? <span className="muted">{s.agentId}</span> : null}
              </p>
              {policy ? (
                <p className={policy.effect === 'deny' ? 'policy policy-deny' : 'policy'}>
                  <Icon name="shield" size={14} />
                  <span>
                    {t('steps.gate', { effect: t(`steps.effects.${policy.effect}` as TKey) })}
                    {policy.reasons.length ? `: ${policy.reasons.join('; ')}` : ''}
                  </span>
                </p>
              ) : null}
              <p className="step-meta muted">
                <time dateTime={s.createdAt}>{fmt.dateTime(s.createdAt)}</time>
                {s.durationMs !== null ? <span>{fmt.duration(s.durationMs)}</span> : null}
                {s.tokensIn || s.tokensOut ? (
                  <span>
                    {t('steps.tokens', {
                      in: fmt.number(s.tokensIn),
                      out: fmt.number(s.tokensOut),
                    })}
                  </span>
                ) : null}
                {s.costMicros ? <span>{fmt.usd(s.costMicros / 1_000_000)}</span> : null}
                {s.provider ? (
                  <span className="mono">
                    {s.provider}/{s.model}
                  </span>
                ) : null}
              </p>
              {s.input !== null && s.input !== undefined ? (
                <details>
                  <summary>{t('steps.input')}</summary>
                  <JsonBlock value={redact(s.input)} />
                </details>
              ) : null}
              {s.output !== null && s.output !== undefined ? (
                <details>
                  <summary>{t('steps.output')}</summary>
                  <JsonBlock value={redact(s.output)} />
                </details>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
