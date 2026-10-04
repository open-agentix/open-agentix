import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { useI18n } from '../../i18n/i18n';
import { isDismissed, setDismissed } from './storage';
import { TOUR_LINKS, TOUR_STEPS, findTarget, placeCard, type Rect } from './steps';

const PAD = 6;
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]';
/** The target may render after navigation (lazy page, data): measure again a few times. */
const REMEASURE_MS = [0, 120, 500];

function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Modal guided tour (demo only). Own component, no library: native dialog (top layer, inert page),
 * explicit focus trap, Esc, arrow keys, spotlight with a centred / bottom-sheet fallback.
 */
export default function TourDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const [index, setIndex] = useState(0);
  const [dont, setDont] = useState(isDismissed);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const checkId = useId();

  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;

  const close = useCallback(() => {
    dialogRef.current?.close?.();
    onClose();
  }, [onClose]);

  // Open as a modal; hand focus back to whoever opened the tour (or the page) on unmount.
  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
    const from = opener.current;
    return () => {
      if (el?.open) el.close();
      const back =
        from instanceof HTMLElement && from.isConnected && from !== document.body
          ? from
          : document.getElementById('main');
      back?.focus?.();
    };
  }, []);

  // Show the page that belongs to the step. Not on mount: the tour opens wherever the visitor is.
  const shown = useRef(index);
  useEffect(() => {
    if (shown.current === index) return;
    shown.current = index;
    if (step.to && step.to !== pathname) void navigate({ to: step.to });
    // The route is only changed when the step changes, never fought against afterwards.
  }, [index]);

  // Move focus to the heading of each step so screen readers announce it.
  useEffect(() => {
    headingRef.current?.focus();
  }, [index]);

  // Locate and track the spotlight target.
  useLayoutEffect(() => {
    const measure = () => {
      const rect = findTarget(step.target, window.innerWidth);
      setSpot(rect);
      if (!rect) return setPlace(null);
      const card = cardRef.current;
      setPlace(
        placeCard(
          rect,
          { width: card?.offsetWidth || 420, height: card?.offsetHeight || 260 },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    const el = step.target
      ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      : null;
    el?.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    measure();
    const timers = REMEASURE_MS.map((ms) => window.setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step.target, index]);

  const go = (next: number) => setIndex(Math.max(0, Math.min(TOUR_STEPS.length - 1, next)));

  const onDont = (checked: boolean) => {
    setDont(checked);
    setDismissed(checked);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowRight' && !last) {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === 'Tab') {
      const items = Array.from(
        cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((n) => !n.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0]!;
      const end = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = !!cardRef.current?.contains(active);
      if (e.shiftKey && (active === first || active === headingRef.current || !inside)) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && (active === end || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const style = spot && place ? { top: place.top, left: place.left } : undefined;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {spot ? (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{
            top: spot.top - PAD,
            left: spot.left - PAD,
            width: spot.width + PAD * 2,
            height: spot.height + PAD * 2,
          }}
        />
      ) : (
        <div className="tour-dim" aria-hidden="true" />
      )}
      <div
        ref={cardRef}
        className={style ? 'tour-card' : 'tour-card tour-card-centered'}
        style={style}
        data-spotlight={spot ? 'on' : 'off'}
      >
        <div className="tour-head">
          <p className="tour-step" aria-live="polite">
            {t('tour.step', { current: index + 1, total: TOUR_STEPS.length })}
          </p>
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            aria-label={t('tour.close')}
            title={t('tour.close')}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {t(`tour.steps.${step.id}.title`)}
        </h2>
        <p id={bodyId}>{t(`tour.steps.${step.id}.body`)}</p>
        {step.id === 'links' ? (
          <ul className="tour-links">
            {TOUR_LINKS.map((l) => (
              <li key={l.key}>
                <a
                  href={l.href}
                  {...(l.href.startsWith('http')
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                >
                  {t(`tour.links.${l.key}`)}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <ol className="tour-dots" aria-label={t('tour.progress')}>
          {TOUR_STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={i === index ? 'tour-dot tour-dot-active' : 'tour-dot'}
                aria-label={t('tour.goTo', { step: i + 1 })}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => go(i)}
              />
            </li>
          ))}
        </ol>
        <label className="check tour-check" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={dont}
            onChange={(e) => onDont(e.target.checked)}
          />
          <span>{t('tour.dontShow')}</span>
        </label>
        <div className="tour-foot">
          <button type="button" className="btn btn-ghost btn-md" onClick={close}>
            {t('tour.skip')}
          </button>
          <span className="tour-spacer" />
          <button
            type="button"
            className="btn btn-secondary btn-md"
            onClick={() => go(index - 1)}
            disabled={index === 0}
          >
            {t('tour.back')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-md"
            onClick={last ? close : () => go(index + 1)}
          >
            {last ? t('tour.done') : t('tour.next')}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
