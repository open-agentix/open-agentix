import { useT } from '../i18n/i18n';

/**
 * Placeholder rows while a list loads. One status message for assistive technology; the grey bars
 * are decorative. The shimmer is switched off by `prefers-reduced-motion` (global rule).
 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="skeleton-list" role="status" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i} aria-hidden="true">
          <span className="skeleton skeleton-w-30" />
          <span className="skeleton skeleton-w-15" />
          <span className="skeleton skeleton-w-20" />
          <span className="skeleton skeleton-w-15" />
          <span className="skeleton skeleton-w-10" />
        </div>
      ))}
    </div>
  );
}
