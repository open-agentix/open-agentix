import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { activeTenant } from '../src/lib/activeTenant';
import { heading, renderApp } from './utils';

const security = { id: f.tenantRow.id, slug: 'security', name: 'Security (demo)' };
const overview = (mode: 'simulated' | 'claude-code') => ({
  llm: {
    mode,
    model: mode === 'claude-code' ? 'haiku' : null,
    dailyBudgetUsd: 1,
    spentTodayUsd: 0.25,
    remainingUsd: 0.75,
  },
  rateLimit: { runs: 3, windowSeconds: 600 },
  tenant: security,
  scenarios: [
    {
      id: 'cve-xz-backdoor',
      title: 'Triage the xz backdoor',
      description: 'A scanner finding arrives.',
      agent: 'cve-triage',
    },
  ],
});

describe('demo scenarios on the dashboard', () => {
  it('is hidden outside demo mode', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(screen.queryByText('Try a scenario')).not.toBeInTheDocument();
  });

  it('starts a fixed scenario and opens the run (simulated model)', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () => HttpResponse.json(overview('simulated'))),
      http.post(api('/v1/demo/scenarios/cve-xz-backdoor/run'), () =>
        HttpResponse.json({ runId: f.ids.run, tenant: security }, { status: 202 }),
      ),
    );
    await renderApp('/');
    expect(await screen.findByText('Try a scenario')).toBeInTheDocument();
    expect(screen.getByText(/Simulated model/)).toBeInTheDocument();
    expect(screen.getByText(/Up to 3 runs per 10 minutes/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /run scenario/i }));
    expect(await screen.findByRole('heading', { name: /#6666/i })).toBeInTheDocument();
  });

  it('shows the live-model budget and the limit error', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () => HttpResponse.json(overview('claude-code'))),
      http.post(api('/v1/demo/scenarios/cve-xz-backdoor/run'), () =>
        HttpResponse.json(
          { error: 'rate_limited', message: 'at most 3 scenario runs per 10 minutes per visitor' },
          { status: 429 },
        ),
      ),
    );
    await renderApp('/');
    expect(
      await screen.findByText(/Live model: haiku\. Budget left today: \$0\.75/),
    ).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /run scenario/i }));
    expect(await screen.findByText(/at most 3 scenario runs/)).toBeInTheDocument();
  });

  it('shows an error when the scenarios cannot be loaded', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 }),
      ),
    );
    await renderApp('/');
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });

  const other = {
    id: 'c0000000-0000-4000-8000-0000000000aa',
    slug: 'platform',
    name: 'Platform (demo)',
  };
  const tenantRows = (list: { id: string; slug: string; name: string }[]) =>
    http.get(api('/v1/tenants'), () =>
      HttpResponse.json({
        items: list.map((t) => ({
          ...f.tenantRow,
          ...t,
          monthlyBudgetUsd: null,
          secretRefs: [],
        })),
      }),
    );

  it('says where runs appear and offers a switch when acting in another tenant', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () => HttpResponse.json(overview('simulated'))),
      tenantRows([security, other]),
    );
    await renderApp('/');
    // Signing in resets the choice, so the tenant is chosen once the page is up.
    await screen.findByText('Try a scenario');
    expect(screen.getByText(/Runs of scenarios appear in Security \(demo\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch to security/i })).not.toBeInTheDocument();
    act(() => activeTenant.set(other));
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Security (demo)' }));
    expect(activeTenant.get()?.id).toBe(security.id);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /switch to security/i })).not.toBeInTheDocument(),
    );
  });

  it('moves to the scenario tenant after starting a scenario', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () => HttpResponse.json(overview('simulated'))),
      http.post(api('/v1/demo/scenarios/cve-xz-backdoor/run'), () =>
        HttpResponse.json({ runId: f.ids.run, tenant: security }, { status: 202 }),
      ),
      tenantRows([security, other]),
    );
    await renderApp('/');
    const runButton = await screen.findByRole('button', { name: /run scenario/i });
    act(() => activeTenant.set(other));
    await userEvent.click(runButton);
    expect(await screen.findByRole('heading', { name: /#6666/i })).toBeInTheDocument();
    expect(activeTenant.get()?.id).toBe(security.id);
  });

  it('explains instead of switching when the account cannot open the scenario tenant', async () => {
    server.use(
      http.get(api('/v1/settings'), () => HttpResponse.json({ ...f.settings, demo: true })),
      http.get(api('/v1/demo/scenarios'), () =>
        HttpResponse.json({ ...overview('simulated'), tenant: other }),
      ),
    );
    await renderApp('/');
    expect(await screen.findByText(/which this account cannot open/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch to/i })).not.toBeInTheDocument();
  });
});
