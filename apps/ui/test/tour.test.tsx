import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocale } from '../src/i18n/i18n';
import de from '../src/i18n/locales/de.json';
import en from '../src/i18n/locales/en.json';
import { shouldAutoStart } from '../src/features/tour/TourHost';
import {
  isDismissed,
  markAutoStarted,
  requestTour,
  resetTour,
  setDismissed,
  takeTourRequest,
  wasAutoStarted,
} from '../src/features/tour/storage';
import { TOUR_LINKS, TOUR_STEPS, findTarget, placeCard } from '../src/features/tour/steps';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

const scenarios = {
  llm: { mode: 'simulated', model: null, dailyBudgetUsd: 1, spentTodayUsd: 0, remainingUsd: 1 },
  rateLimit: { runs: 3, windowSeconds: 600 },
  tenant: { id: f.tenantRow.id, slug: 'security', name: 'Security (demo)' },
  scenarios: [{ id: 'cve-xz-backdoor', title: 'Triage', description: 'A finding.', agent: 'a' }],
};

function demoServer() {
  server.use(
    http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
    http.get(api('/v1/demo/scenarios'), () => HttpResponse.json(scenarios)),
  );
}

// The dialog is a lazy chunk: allow for slow machines.
const tourDialog = () =>
  screen.findByRole('dialog', { name: /welcome|tour|scenario|run|audit/i }, { timeout: 5000 });

beforeEach(() => resetTour());
afterEach(() => vi.unstubAllEnvs());

describe('tour storage', () => {
  it('persists the dismissal and clears it again', () => {
    expect(isDismissed()).toBe(false);
    setDismissed(true);
    expect(isDismissed()).toBe(true);
    expect(window.localStorage.getItem('oax.tour.dismissed')).toBe('1');
    setDismissed(false);
    expect(isDismissed()).toBe(false);
  });

  it('falls back to the session and then to memory when storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setDismissed(true);
    expect(isDismissed()).toBe(true);
    markAutoStarted();
    expect(wasAutoStarted()).toBe(true);
    requestTour();
    expect(takeTourRequest()).toBe(true);
    expect(takeTourRequest()).toBe(false);
    setDismissed(false);
    expect(isDismissed()).toBe(false);
    spy.mockRestore();
    get.mockRestore();
  });

  it('survives storage objects that throw on access', () => {
    const local = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const session = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    setDismissed(true);
    expect(isDismissed()).toBe(true);
    resetTour();
    expect(isDismissed()).toBe(false);
    local.mockRestore();
    session.mockRestore();
  });

  it('uses the session when only localStorage is blocked', () => {
    const local = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    setDismissed(true);
    expect(window.sessionStorage.getItem('oax.tour.dismissed')).toBe('1');
    expect(isDismissed()).toBe(true);
    local.mockRestore();
  });
});

describe('tour steps and helpers', () => {
  it('has 6 to 8 unique steps with English and German texts', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(6);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(8);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const dict of [en, de]) {
      for (const s of TOUR_STEPS) {
        expect(dict.tour.steps[s.id].title).toBeTruthy();
        expect(dict.tour.steps[s.id].body.length).toBeGreaterThan(40);
      }
      for (const l of TOUR_LINKS) expect(dict.tour.links[l.key]).toBeTruthy();
    }
    expect(isLocale('de')).toBe(true);
  });

  it('keeps the contact points of the last step', () => {
    const hrefs = TOUR_LINKS.map((l) => l.href);
    expect(hrefs).toContain('mailto:info@openagentix.si');
    expect(hrefs.some((h) => h.endsWith('/discussions'))).toBe(true);
    expect(en.tour.steps.links.body).toContain('info@openagentix.si');
  });

  it('places the card beside, below, above or not at all', () => {
    const card = { width: 400, height: 200 };
    const vp = { width: 1200, height: 800 };
    expect(placeCard({ top: 100, left: 20, width: 200, height: 40 }, card, vp)).toEqual({
      top: 100,
      left: 236,
    });
    expect(placeCard({ top: 700, left: 900, width: 280, height: 40 }, card, vp)).toEqual({
      top: 484,
      left: 784,
    });
    expect(placeCard({ top: 100, left: 900, width: 280, height: 40 }, card, vp)).toEqual({
      top: 156,
      left: 784,
    });
    expect(placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, vp)).toBeNull();
  });

  it('finds visible anchors only and never on small screens', () => {
    const el = document.createElement('div');
    el.setAttribute('data-tour', 'x');
    document.body.append(el);
    el.getBoundingClientRect = () => ({ top: 1, left: 2, width: 3, height: 4 }) as DOMRect;
    expect(findTarget('x', 1200)).toEqual({ top: 1, left: 2, width: 3, height: 4 });
    expect(findTarget('x', 600)).toBeNull();
    expect(findTarget('missing', 1200)).toBeNull();
    expect(findTarget(undefined, 1200)).toBeNull();
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 }) as DOMRect;
    expect(findTarget('x', 1200)).toBeNull();
    el.remove();
  });

  it('auto-starts once, in demo mode, on the dashboard, unless dismissed', () => {
    const base = { demo: true, pathname: '/', dismissed: false, alreadyStarted: false };
    expect(shouldAutoStart(base)).toBe(true);
    expect(shouldAutoStart({ ...base, demo: false })).toBe(false);
    expect(shouldAutoStart({ ...base, pathname: '/runs' })).toBe(false);
    expect(shouldAutoStart({ ...base, dismissed: true })).toBe(false);
    expect(shouldAutoStart({ ...base, alreadyStarted: true })).toBe(false);
  });
});

describe('tour in the app', () => {
  it('does not exist outside demo mode', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take the tour/i })).not.toBeInTheDocument();
  });

  it('starts on its own with an accessible modal and walks through all steps', async () => {
    demoServer();
    const { user } = await renderApp('/');
    const dialog = await tourDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Step 1 of 8')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: /welcome to the open-agentix demo/i }),
    ).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeDisabled();
    await expectNoA11yViolations(dialog);

    for (let i = 2; i <= 8; i++) {
      await user.click(within(dialog).getByRole('button', { name: i === 8 ? 'Next' : 'Next' }));
      expect(within(dialog).getByText(`Step ${i} of 8`)).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('heading', { name: /where to go next/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'GitHub Discussions' })).toHaveAttribute(
      'href',
      'https://github.com/open-agentix/open-agentix/discussions',
    );
    expect(within(dialog).getByRole('link', { name: 'info@openagentix.si' })).toHaveAttribute(
      'href',
      'mailto:info@openagentix.si',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByText('Step 7 of 8')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Go to step 8' }));
    await user.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the pages of the steps behind the dialog', async () => {
    demoServer();
    const { user, router } = await renderApp('/');
    const dialog = await tourDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Go to step 4' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'));
  });

  it('opens where the visitor is and does not navigate away on its own', async () => {
    demoServer();
    requestTour(); // starts anywhere when asked for
    const { router } = await renderApp('/runs');
    await tourDialog();
    await router.navigate({ to: '/audit' });
    expect(router.state.location.pathname).toBe('/audit');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts only once per session and Esc closes it and returns focus', async () => {
    demoServer();
    const { user, router } = await renderApp('/');
    await tourDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(isDismissed()).toBe(false);
    expect(wasAutoStarted()).toBe(true);
    // Back on the dashboard: no second automatic start.
    await router.navigate({ to: '/runs' });
    await router.navigate({ to: '/' });
    await heading(/hello ada admin/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('remembers "Don\'t show this again" and does not auto-start afterwards', async () => {
    demoServer();
    const { user, unmount } = await renderApp('/');
    const dialog = await tourDialog();
    const check = within(dialog).getByRole('checkbox', { name: "Don't show this again" });
    expect(check).not.toBeChecked();
    await user.click(check);
    expect(isDismissed()).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('checkbox', { name: "Don't show this again" })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Skip tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    unmount();

    window.sessionStorage.clear();
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('can be restarted any time and ignores the dismissal; the checkbox can be unticked', async () => {
    demoServer();
    setDismissed(true);
    const { user } = await renderApp('/');
    await heading(/hello ada admin/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Take the tour' }));
    const dialog = await tourDialog();
    const check = within(dialog).getByRole('checkbox', { name: "Don't show this again" });
    expect(check).toBeChecked();
    await user.click(check);
    expect(isDismissed()).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Close the tour' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Take the tour' })).toHaveFocus();
  });

  it('traps focus, supports arrow keys and works with blocked storage', async () => {
    demoServer();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = await renderApp('/');
    const dialog = await tourDialog();
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByText('Step 2 of 8')).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(within(dialog).getByText('Step 1 of 8')).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(within(dialog).getByText('Step 1 of 8')).toBeInTheDocument();

    const next = within(dialog).getByRole('button', { name: 'Next' });
    next.focus();
    // Forward from the last control wraps to the first one, backwards from the first to the last.
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Close the tour' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(next).toHaveFocus();

    await user.click(within(dialog).getByRole('checkbox', { name: "Don't show this again" }));
    expect(isDismissed()).toBe(true);
    get.mockRestore();
    set.mockRestore();
  });

  it('falls back to a centred card without a target and spotlights when one is visible', async () => {
    demoServer();
    const { user } = await renderApp('/');
    const dialog = await tourDialog();
    // jsdom has no layout: every anchor has no size, so the card is centred.
    expect(dialog.querySelector('.tour-card')).toHaveAttribute('data-spotlight', 'off');
    expect(dialog.querySelector('.tour-card')).toHaveClass('tour-card-centered');

    const target = document.querySelector<HTMLElement>('[data-tour="nav-/runs"]')!;
    expect(target).not.toBeNull();
    target.getBoundingClientRect = () =>
      ({ top: 100, left: 10, width: 200, height: 36 }) as DOMRect;
    await user.click(within(dialog).getByRole('button', { name: 'Go to step 3' }));
    await waitFor(() =>
      expect(dialog.querySelector('.tour-card')).toHaveAttribute('data-spotlight', 'on'),
    );
    expect(dialog.querySelector('.tour-spot')).toBeInTheDocument();

    // A small screen never gets a spotlight.
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() =>
      expect(dialog.querySelector('.tour-card')).toHaveAttribute('data-spotlight', 'off'),
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  });

  it('is available in German', async () => {
    demoServer();
    await renderApp('/', { locale: 'de' });
    const dialog = await screen.findByRole('dialog', { name: /willkommen/i }, { timeout: 5000 });
    expect(within(dialog).getByText('Schritt 1 von 8')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Tour überspringen' })).toBeInTheDocument();
  });
});

describe('login hint', () => {
  it('lists every demo account with a role line and fills the one that is clicked', async () => {
    vi.stubEnv('VITE_OAX_DEMO', 'true');
    demoServer();
    const { user } = await renderApp('/login', { signedIn: false });
    const hint = await screen.findByRole('complementary', { name: /public demo/i });
    for (const who of [
      'owner',
      'admin',
      'engineer',
      'integrator',
      'operator',
      'auditor',
      'viewer',
      'contractor',
    ])
      expect(within(hint).getByText(`${who}@example.org`)).toBeInTheDocument();
    expect(
      within(hint).getByText('Platform admin: sees all tenants and the tenant switcher.'),
    ).toBeInTheDocument();
    expect(within(hint).getByText('Admin of the Security tenant.')).toBeInTheDocument();
    // Only fictional example.org accounts, one shared password.
    expect(hint.textContent).not.toMatch(/@(?!example\.org)[\w.-]+\.[a-z]{2,}/i);
    expect(within(hint).getAllByText('demo-password-2026')).toHaveLength(1);
    await user.click(within(hint).getByRole('button', { name: 'Fill in owner@example.org' }));
    expect(screen.getByLabelText(/username or email/i)).toHaveValue('owner@example.org');
    expect(screen.getByLabelText(/^password/i)).toHaveValue('demo-password-2026');
  });

  it('is hidden in normal builds', async () => {
    await renderApp('/login', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/public demo/i)).not.toBeInTheDocument();
  });

  it('shows the shared fake credentials, fills them in and starts the tour after sign-in', async () => {
    vi.stubEnv('VITE_OAX_DEMO', 'true');
    demoServer();
    server.use(
      http.post(api('/v1/auth/login'), () =>
        HttpResponse.json({ token: 'oax_test_session_token', expiresAt: '2099-01-01T00:00:00Z' }),
      ),
    );
    setDismissed(true);
    const { user } = await renderApp('/login', { signedIn: false });
    const hint = await screen.findByRole('complementary', { name: /public demo/i });
    expect(within(hint).getByText('admin@example.org')).toBeInTheDocument();
    expect(within(hint).getByText('demo-password-2026')).toBeInTheDocument();
    expect(within(hint).getByText(/resets nightly/i)).toBeInTheDocument();
    await user.click(within(hint).getByRole('button', { name: 'Fill in' }));
    expect(screen.getByLabelText(/username or email/i)).toHaveValue('admin@example.org');
    await user.click(within(hint).getByRole('button', { name: 'Take the tour' }));
    expect(within(hint).getByRole('status')).toHaveTextContent(/as soon as you have signed in/i);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // Requested explicitly, so it starts although the dismissal flag is set.
    expect(
      await screen.findByRole('dialog', { name: /welcome/i }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
