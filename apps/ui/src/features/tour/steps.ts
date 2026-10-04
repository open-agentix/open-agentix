import type { NavItem } from '../../layout/nav';

export type StepId =
  'welcome' | 'scenario' | 'runs' | 'audit' | 'costs' | 'agents' | 'connections' | 'links';

export interface TourStep {
  id: StepId;
  /** Spotlighted element (`data-tour` value); the step is a centred card without it. */
  target?: string;
  /** Page shown while the step is active. */
  to?: NavItem['to'];
}

/** Anchors are `data-tour` attributes on the real UI; keep in sync with the components. */
export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'welcome', target: 'whoami', to: '/' },
  { id: 'scenario', target: 'demo-scenarios', to: '/' },
  { id: 'runs', target: 'nav-/runs', to: '/runs' },
  { id: 'audit', target: 'nav-/audit', to: '/audit' },
  { id: 'costs', target: 'nav-/costs', to: '/costs' },
  { id: 'agents', target: 'nav-/users', to: '/users' },
  { id: 'connections', target: 'nav-/connections', to: '/connections' },
  { id: 'links', to: '/' },
];

/** Static links of the last step (plain navigation, nothing is fetched). */
export const TOUR_LINKS = [
  { key: 'docs', href: 'https://github.com/open-agentix/open-agentix/tree/main/docs' },
  { key: 'github', href: 'https://github.com/open-agentix/open-agentix' },
  { key: 'discussions', href: 'https://github.com/open-agentix/open-agentix/discussions' },
  { key: 'blog', href: 'https://blog.openagentix.si' },
  { key: 'mail', href: 'mailto:info@openagentix.si' },
] as const;

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Viewports up to this width use the bottom sheet without spotlight (matches the shell breakpoint). */
export const SHEET_MAX_WIDTH = 900;

const GAP = 16;

/** Position of the card next to the spotlight, or null to centre it. */
export function placeCard(
  target: Rect,
  card: Size,
  viewport: Size,
): { top: number; left: number } | null {
  const clampTop = (top: number) =>
    Math.max(GAP, Math.min(top, viewport.height - card.height - GAP));
  const clampLeft = (left: number) =>
    Math.max(GAP, Math.min(left, viewport.width - card.width - GAP));
  const right = target.left + target.width + GAP;
  if (right + card.width <= viewport.width - GAP) {
    return { top: clampTop(target.top), left: right };
  }
  const below = target.top + target.height + GAP;
  if (below + card.height <= viewport.height - GAP) {
    return { top: below, left: clampLeft(target.left) };
  }
  const above = target.top - GAP - card.height;
  if (above >= GAP) return { top: above, left: clampLeft(target.left) };
  return null;
}

/** Rect of a visible anchor, or null (missing, hidden, zero-sized, small screen). */
export function findTarget(target: string | undefined, viewportWidth: number): Rect | null {
  if (!target || viewportWidth <= SHEET_MAX_WIDTH) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}
