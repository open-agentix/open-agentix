import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { todayStats } from '../src/features/dashboard/DashboardPage';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

describe('app shell', () => {
  it('shows the full navigation, versions and pending approvals for admins', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const name of [
      'Dashboard',
      'Workflow wizard',
      'Agents',
      'Runs',
      'Audit trail',
      'API tokens',
      'Settings',
    ]) {
      expect(within(nav).getByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await within(nav).findByLabelText('1 approval pending')).toBeInTheDocument();
    expect(await screen.findByText('UI v0.0.0 · API v0.1.0')).toBeInTheDocument();
  });

  it('hides what a viewer may not use', async () => {
    asViewer();
    await renderApp('/');
    await heading(/hello vic viewer/i);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: /audit trail/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /connections/i })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /runs/i })).toBeInTheDocument();
    expect(screen.queryByText(/recent audit events/i)).not.toBeInTheDocument();
  });

  it('switches language and remembers it', async () => {
    const { user } = await renderApp('/');
    await heading(/hello/i);
    await user.selectOptions(screen.getAllByLabelText('Language')[0]!, 'de');
    await heading(/hallo ada admin/i);
    expect(document.documentElement.lang).toBe('de');
    expect(window.localStorage.getItem('oax.locale')).toBe('de');
    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeInTheDocument();
  });

  it('switches the theme', async () => {
    const { user } = await renderApp('/');
    await heading(/hello/i);
    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: 'System theme' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('opens and closes the mobile menu', async () => {
    const { user } = await renderApp('/');
    await heading(/hello/i);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('shows a not-found page', async () => {
    await renderApp('/does-not-exist');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('shows an error when /me fails with a server error', async () => {
    server.use(
      http.get(api('/v1/me'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 503 }),
      ),
    );
    await renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });
});

describe('dashboard', () => {
  it('summarises runs, costs, approvals, workers and audit events', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    const runsToday = await screen.findByText('Runs today');
    await waitFor(() => expect(runsToday.nextSibling).toHaveTextContent('2'));
    expect(screen.getByText('1 still active')).toBeInTheDocument();
    expect(await screen.findByText('$9.001')).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: /budget used/i })).toHaveAttribute(
      'aria-valuenow',
      '9.001',
    );
    expect(await screen.findByText(/1 tool call waits for approval/i)).toBeInTheDocument();
    expect(await screen.findByText('1 active policy')).toBeInTheDocument();
    expect(await screen.findByText('in-process')).toBeInTheDocument();
    expect(await screen.findByText('agent.published')).toBeInTheDocument();
    expect((await screen.findAllByText('ticket-updater')).length).toBeGreaterThan(0);
    await expectNoA11yViolations();
  });

  it('shows empty states', async () => {
    server.use(
      http.get(api('/v1/runs'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/approvals'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/teams'), () => HttpResponse.json({ items: [] })),
      http.get(api('/v1/audit'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/');
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(await screen.findByText(/nothing waits for you/i)).toBeInTheDocument();
    expect(await screen.findByText('No team budget set')).toBeInTheDocument();
    expect(await screen.findByText('No audit entries')).toBeInTheDocument();
  });

  it('shows errors per section', async () => {
    server.use(
      http.get(api('/v1/runs'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'no' }, { status: 403 }),
      ),
      http.get(api('/v1/settings'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 }),
      ),
      http.get(api('/v1/audit'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 }),
      ),
    );
    await renderApp('/');
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/something went wrong/i)).length).toBeGreaterThanOrEqual(2);
  });

  it('counts runs of today only', () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const old = { ...f.finishedRun, createdAt: '2020-01-01T00:00:00.000Z' };
    const fresh = { ...f.run, createdAt: new Date().toISOString() };
    expect(todayStats([fresh, old], true, since)).toEqual({
      total: 1,
      succeeded: 0,
      failed: 0,
      active: 1,
      partial: false,
    });
    expect(todayStats([fresh], true, since).partial).toBe(true);
  });
});
