import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

const original = window.matchMedia;
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('max-width: 600px'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
beforeEach(() => setPhone(true));
afterEach(() => {
  window.matchMedia = original;
  vi.unstubAllEnvs();
});

describe('scope chip', () => {
  it('shows the Scope chip on list pages and passes axe', async () => {
    setPhone(false);
    await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByRole('group', { name: 'Scope: Acme' })).toBeInTheDocument();
    await expectNoA11yViolations();
  });
});

describe('card rows on phones', () => {
  it('shows every agent field as a card instead of hiding columns', async () => {
    await renderApp('/agents');
    await heading('Agents');
    const list = await screen.findByRole('list', { name: 'Agents' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    const first = cards[0]!;
    expect(within(first).getByRole('link', { name: 'ticket-updater' })).toBeInTheDocument();
    expect(within(first).getByText(/v1\.0\.0/)).toBeInTheDocument();
    expect(within(first).getByText('Moves triaged tickets')).toBeInTheDocument();
    expect(within(first).getByText('Changed')).toBeInTheDocument();
    expect(within(first).getByRole('group', { name: 'Tenant: Acme' })).toBeInTheDocument();
    expect(within(first).getByText('vulnerability-management')).toBeInTheDocument();
    expect(within(first).getByText('Security')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: /Failed/ })).toBeInTheDocument();
    expect(
      within(first).getByRole('progressbar', { name: /Budget used: 82%/ }),
    ).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Draft')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('keeps the table on wide screens', async () => {
    setPhone(false);
    await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect((await screen.findAllByRole('group', { name: 'Tenant: Acme' })).length).toBeGreaterThan(
      0,
    );
  });

  it('lets a viewer read the owner team (it comes with the agent, no users:read needed)', async () => {
    asViewer();
    await renderApp('/agents');
    await heading('Agents');
    const list = await screen.findByRole('list', { name: 'Agents' });
    expect(within(list).getByText('Security')).toBeInTheDocument();
    expect(screen.queryByText(/^Team 3333/)).not.toBeInTheDocument();
  });

  it('falls back to a neutral team label when team names cannot be loaded', async () => {
    server.use(
      http.get(api('/v1/teams'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'no' }, { status: 403 }),
      ),
    );
    await renderApp('/runs');
    await heading('Runs');
    expect((await screen.findAllByText('Team 33333333')).length).toBeGreaterThan(0);
  });

  it('renders runs as cards with agent, team, tenant, cost and a status', async () => {
    await renderApp('/runs');
    await heading('Runs');
    const list = await screen.findByRole('list', { name: 'Runs' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByRole('link', { name: /#6666/ })).toBeInTheDocument();
    expect(within(first).getByText('Awaiting approval')).toBeInTheDocument();
    expect(within(first).getByRole('group', { name: 'Tenant: Acme' })).toBeInTheDocument();
    expect(await within(first).findByText('Security')).toBeInTheDocument();
    expect(within(first).getByText('$0.0042')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('renders audit, events and costs as cards too', async () => {
    const audit = await renderApp('/audit');
    await heading(/audit/i);
    expect(await screen.findByRole('list', { name: /audit/i })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    audit.unmount();

    const events = await renderApp('/events');
    await heading(/events/i);
    expect(await screen.findByRole('list', { name: /recent events/i })).toBeInTheDocument();
    events.unmount();

    await renderApp('/costs');
    await heading(/cost/i);
    const list = await screen.findByRole('list', { name: /cost/i });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
