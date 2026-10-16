import type { ReviewThread } from '../../api/types';
import { Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { CommentForm } from './CommentForm';
import type { ReviewActions } from './reviewActions';
import { ThreadCard } from './ThreadCard';

interface Shared {
  open: boolean;
  meId: string | undefined;
  name: (id: string | null) => string;
  actions: ReviewActions;
}

/** Threads about the review as a whole, with a box to start one. */
export function GeneralThreads({
  threads,
  canComment,
  ...shared
}: Shared & { threads: ReviewThread[]; canComment: boolean }) {
  const { t } = useI18n();
  return (
    <Section title={t('reviews.threads.general')}>
      {threads.length === 0 ? <p className="muted">{t('reviews.threads.noGeneral')}</p> : null}
      {threads.map((th) => (
        <ThreadCard key={th.id} thread={th} context={t('reviews.thread.review')} {...shared} />
      ))}
      {shared.open && canComment ? (
        <CommentForm
          label={t('reviews.threads.startLabel')}
          submitLabel={t('reviews.threads.start')}
          onSubmit={(text) => shared.actions.startThread(text)}
        />
      ) : null}
    </Section>
  );
}

/** Threads whose line changed since they were written: kept, anchored to the revision they were on. */
export function OutdatedThreads({ threads, ...shared }: Shared & { threads: ReviewThread[] }) {
  const { t } = useI18n();
  if (threads.length === 0) return null;
  return (
    <Section title={t('reviews.threads.outdated')}>
      <p className="muted">{t('reviews.threads.outdatedText')}</p>
      {threads.map((th) => (
        <ThreadCard
          key={th.id}
          thread={th}
          context={t('reviews.thread.lineOfRevision', {
            line: th.anchor?.line ?? 0,
            revision: th.anchor?.revisionSeq ?? '?',
          })}
          {...shared}
        />
      ))}
    </Section>
  );
}
