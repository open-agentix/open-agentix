import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http } from 'msw';
import { expect } from 'vitest';
import { App } from '../src/App';
import { session } from '../src/auth/session';
import { loadLocale, type Locale } from '../src/i18n/i18n';
import { createQueryClient } from '../src/lib/queryClient';
import { createAppRouter } from '../src/router';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';

export function signIn(): void {
  session.set('oax_test_session_token', new Date(Date.now() + 3_600_000).toISOString());
}

export function asViewer(): void {
  server.use(http.get(api('/v1/me'), () => Response.json(f.meViewer)));
}

export async function renderApp(path: string, { locale = 'en' as Locale, signedIn = true } = {}) {
  if (signedIn) signIn();
  await loadLocale(locale);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(queryClient, history);
  const user = userEvent.setup();
  const view = render(<App router={router} queryClient={queryClient} locale={locale} />);
  return { ...view, router, queryClient, user };
}

/** Waits for the page heading (lazy routes resolve asynchronously). */
export async function heading(name: string | RegExp) {
  return screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });
}

/** Runs axe-core on the rendered document (color contrast is checked visually, not in jsdom). */
export async function expectNoA11yViolations(container: Element = document.body) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary).toEqual([]);
}
