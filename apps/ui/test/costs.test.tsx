import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { budgetAlert, periodStart } from '../src/features/costs/CostsPage';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('costs', () => {
  it('groups costs, shows budgets with alerts and is accessible', async () => {
    const { user, router } = await renderApp('/costs');
    await heading('Costs');
    expect(await screen.findByRole('cell', { name: 'ticket-updater' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.getAllByText('$9.001').length).toBeGreaterThan(0);
    expect(await screen.findByText('Above 80 %')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.click(screen.getByRole('tab', { name: 'Team' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ groupBy: 'team' }));
    expect(await screen.findByRole('cell', { name: 'Security' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(await screen.findByRole('cell', { name: '#66666666' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Model' }));
    expect(await screen.findByRole('cell', { name: 'sim-1' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Period'), 'all');
    await user.selectOptions(screen.getByLabelText('Period'), '30d');
  });

  it('shows exceeded budgets, empty and error states', async () => {
    server.use(
      http.get(api('/v1/costs/summary'), ({ request }) => {
        const g = new URL(request.url).searchParams.get('groupBy');
        return g === 'team'
          ? HttpResponse.json({
              groupBy: g,
              items: [
                {
                  key: '33333333-3333-4333-8333-333333333333',
                  tokensIn: 1,
                  tokensOut: 1,
                  costMicros: 1,
                  costUsd: 12,
                },
              ],
            })
          : HttpResponse.json({ groupBy: g, items: [] });
      }),
    );
    await renderApp('/costs');
    expect(await screen.findByText('Budget exceeded')).toBeInTheDocument();
    expect(await screen.findByText('No costs in this period')).toBeInTheDocument();
    server.use(
      http.get(api('/v1/costs/summary'), () =>
        HttpResponse.json({ error: 'x', message: 'no costs' }, { status: 500 }),
      ),
    );
  });

  it('shows errors', async () => {
    server.use(
      http.get(api('/v1/costs/summary'), () =>
        HttpResponse.json({ error: 'x', message: 'ledger down' }, { status: 500 }),
      ),
    );
    await renderApp('/costs');
    expect(await screen.findByText('ledger down')).toBeInTheDocument();
  });

  it('computes periods and budget alerts', () => {
    const now = new Date(2026, 9, 15);
    expect(new Date(periodStart('month', now)!).getDate()).toBe(1);
    expect(periodStart('30d', now)).toBe(new Date(now.getTime() - 30 * 86_400_000).toISOString());
    expect(periodStart('all', now)).toBeUndefined();
    expect(budgetAlert(5, null)).toBe('none');
    expect(budgetAlert(5, 10)).toBe('ok');
    expect(budgetAlert(8, 10)).toBe('warning');
    expect(budgetAlert(10, 10)).toBe('exceeded');
  });
});
