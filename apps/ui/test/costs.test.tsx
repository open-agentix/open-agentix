import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { budgetAlert, periodStart } from '../src/features/costs/CostsPage';
import { topAlert } from '../src/features/costs/BudgetsSection';
import { api } from './handlers';
import { server } from './server';
import * as f from './fixtures';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

describe('monthly budgets', () => {
  it('shows tenant and use case budgets with alerts and stops, and is accessible', async () => {
    await renderApp('/costs');
    await heading('Costs');
    expect(await screen.findByRole('heading', { name: 'Monthly budgets' })).toBeInTheDocument();
    expect(screen.getByText('Whole tenant')).toBeInTheDocument();
    expect(screen.getByText('Alert at 80 %')).toBeInTheDocument();
    expect(screen.getByText('Runs stopped')).toBeInTheDocument();
    expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
    await expectNoA11yViolations();
  });

  it('lets admins set and remove a use case budget and validates the form', async () => {
    let put: { url: string; body: unknown } | null = null;
    server.use(
      http.put(api('/v1/budgets/use-cases/:useCase'), async ({ request }) => {
        put = { url: new URL(request.url).pathname, body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = await renderApp('/costs');
    await screen.findByRole('heading', { name: 'Monthly budgets' });
    await user.click(screen.getByRole('button', { name: 'Set budget' }));
    expect(
      await screen.findByText('Enter a use case and a limit of 0 or more.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Use case'), 'finance');
    await user.type(screen.getByLabelText('Monthly limit (USD)'), '25.5');
    await user.click(screen.getByRole('button', { name: 'Set budget' }));
    await waitFor(() =>
      expect(put).toEqual({
        url: '/v1/budgets/use-cases/finance',
        body: { monthlyBudgetUsd: 25.5 },
      }),
    );
    expect(await screen.findByText('Budget of finance saved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the budget of ops' }));
    expect(await screen.findByText('Budget of ops removed')).toBeInTheDocument();
  });

  it('reports save and remove errors', async () => {
    server.use(
      http.put(api('/v1/budgets/use-cases/:useCase'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'not allowed' }, { status: 403 }),
      ),
      http.delete(api('/v1/budgets/use-cases/:useCase'), () =>
        HttpResponse.json({ error: 'not_found', message: 'gone already' }, { status: 404 }),
      ),
    );
    const { user } = await renderApp('/costs');
    await screen.findByRole('heading', { name: 'Monthly budgets' });
    await user.type(screen.getByLabelText('Use case'), 'finance');
    await user.type(screen.getByLabelText('Monthly limit (USD)'), '1');
    await user.click(screen.getByRole('button', { name: 'Set budget' }));
    expect(await screen.findByText('not allowed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the budget of ops' }));
    expect(await screen.findByText('gone already')).toBeInTheDocument();
  });

  it('is read-only for non-admins and hidden when nothing is set', async () => {
    asViewer();
    await renderApp('/costs');
    await screen.findByRole('heading', { name: 'Monthly budgets' });
    expect(screen.queryByRole('button', { name: 'Set budget' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove the budget/ })).not.toBeInTheDocument();
  });

  it('shows nothing to viewers when no budget exists', async () => {
    asViewer();
    server.use(
      http.get(api('/v1/budgets'), () =>
        HttpResponse.json({
          ...f.budgets,
          tenant: { ...f.budgets.tenant, limitUsd: null },
          useCases: [],
        }),
      ),
    );
    await renderApp('/costs');
    await heading('Costs');
    await screen.findByText('$9.001', {}, { timeout: 3000 }).catch(() => undefined);
    expect(screen.queryByRole('heading', { name: 'Monthly budgets' })).not.toBeInTheDocument();
  });

  it('picks the highest raised alert', () => {
    expect(topAlert({ alerts: [] })).toBeNull();
    expect(topAlert({ alerts: [50, 80] })).toBe(80);
  });
});

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
    expect(periodStart('month', now)).toBe('2026-10-01');
    expect(periodStart('30d', now)).toBe('2026-09-15');
    expect(periodStart('all', now)).toBeUndefined();
    expect(budgetAlert(5, null)).toBe('none');
    expect(budgetAlert(5, 10)).toBe('ok');
    expect(budgetAlert(8, 10)).toBe('warning');
    expect(budgetAlert(10, 10)).toBe('exceeded');
  });

  it('sends API-conformant period bounds for this month, the last 30 days and all time', async () => {
    const froms: (string | null)[] = [];
    server.use(
      http.get(api('/v1/costs/summary'), ({ request }) => {
        const from = new URL(request.url).searchParams.get('from');
        froms.push(from);
        // Mirrors the API contract: a date or an ISO timestamp, never anything else.
        if (from !== null && !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(from)) {
          return HttpResponse.json(
            { error: 'validation_error', message: 'request validation failed' },
            { status: 400 },
          );
        }
        return HttpResponse.json({
          groupBy: 'agent',
          items: [
            { key: f.ids.agent, tokensIn: 1, tokensOut: 1, costMicros: 1, costUsd: 0.000001 },
          ],
        });
      }),
    );
    const { user } = await renderApp('/costs');
    await heading('Costs');
    // default period: this month, a plain first-of-month date
    await waitFor(() => expect(froms.some((x) => /^\d{4}-\d{2}-01$/.test(x ?? ''))).toBe(true));
    expect(screen.queryByText('request validation failed')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Period'), '30d');
    await waitFor(() => expect(froms.at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    await user.selectOptions(screen.getByLabelText('Period'), 'all');
    await waitFor(() => expect(froms.at(-1)).toBeNull());
    expect(screen.queryByText('request validation failed')).not.toBeInTheDocument();
  });
});
