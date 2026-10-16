import type { Agent, Review } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../i18n/i18n';
import {
  lifecycleStatus,
  STATUS_LABEL,
  STATUS_TONE,
  type LifecycleStatus,
} from './lifecycleStatus';

const ICON: Record<LifecycleStatus, IconName> = {
  in_development: 'edit',
  review_requested: 'clock',
  changes_requested: 'alert',
  approved: 'check',
  published: 'shield',
};

/** The status badge of an agent: text and icon, never colour alone. */
export function LifecycleBadge({
  agent,
  review,
}: {
  agent: Pick<Agent, 'status'>;
  review: Pick<Review, 'status' | 'state'> | null | undefined;
}) {
  const t = useT();
  const status = lifecycleStatus(agent, review);
  return (
    <span className={`badge badge-${STATUS_TONE[status]}`} data-status={status}>
      <Icon name={ICON[status]} size={13} />
      {t(STATUS_LABEL[status])}
    </span>
  );
}
