import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSummary } from '../src/api/types';
import { attentionReasons } from '../src/features/agents/AgentsPage';
import * as f from './fixtures';
import { agentsList, api } from './handlers';
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
afterEach(() => {
  window.matchMedia = original;
});

const sec = { id: 't-sec', slug: 'security', name: 'Security' };
const prod = { id: 't-prod', slug: 'product', name: 'Product' };
let n = 0;
/** Fictional agents of the demo tree (example.org only); newest first, like the API. */
function agent(over: Partial<AgentSummary> & { name: string }): AgentSummary {
  n += 1;
  return {
    ...f.agent,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    description: null,
    lastRun: null,
    budget: null,
    ...over,
  };
}
const tree = () => [
  agent({
    name: 'cve-triage',
    useCase: 'vulnerability-management',
    ownerTeam: sec,
    teamId: sec.id,
    status: 'published',
  }),
  agent({
    name: 'hardening-review',
    useCase: 'governance',
    ownerTeam: sec,
    teamId: sec.id,
    status: 'changed',
    lastRun: {
      id: f.ids.run2,
      status: 'failed',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  }),
  agent({
    name: 'feature-builder',
    useCase: 'software-factory',
    ownerTeam: prod,
    teamId: prod.id,
    status: 'draft',
    latestVersion: null,
  }),
  agent({
    name: 'docs-helper',
    useCase: 'software-factory/docs',
    ownerTeam: prod,
    teamId: prod.id,
    status: 'published',
    lastRun: {
      id: f.ids.run,
      status: 'succeeded',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
    budget: {
      limitUsd: 100,
      spentUsd: 4,
      percentUsed: 4,
      source: 'tenant',
      sourceName: 'Example Org',
    },
  }),
  agent({
    name: 'release-watch',
    useCase: null,
    ownerTeam: null,
    teamId: null,
    status: 'published',
  }),
];
const useTree = (list = tree()) => server.use(http.get(api('/v1/agents'), agentsList(list)));

const names = () =>
  screen
    .queryAllByRole('link')
    .map((l) => l.textContent)
    .filter((x) => tree().some((a) => a.name === x));

describe('agents list v2: columns', () => {
  it('shows status, use case, owner team, tenant, last run and budget with accessible text', async () => {
    await renderApp('/agents');
    await heading('Agents');
    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Name / version',
      'Status',
      'Tenant',
      'Use case',
      'Owner team',
      'Last run',
      'Budget used',
    ]);
    const row = within(table).getByRole('link', { name: 'ticket-updater' }).closest('tr')!;
    expect(within(row).getByText('Changed')).toBeInTheDocument();
    expect(within(row).getByText('vulnerability-management')).toBeInTheDocument();
    expect(within(row).getByText('Security')).toBeInTheDocument();
    expect(within(row).getByRole('group', { name: 'Tenant: Acme' })).toBeInTheDocument();
    const run = within(row).getByRole('link', { name: /Failed/ });
    expect(run).toHaveAttribute('href', `/runs/${f.ids.run}`);
    const bar = within(row).getByRole('progressbar');
    expect(bar).toHaveAccessibleName(
      /Budget used: 82%\. Team budget \(Security\): \$41\.00 of \$50\.00/,
    );
    expect(
      within(row).getByText(/needs attention: last run failed, budget almost used up/i),
    ).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('marks never-run, budget-less and use-case-less agents with text, not just a dash', async () => {
    await renderApp('/agents');
    await heading('Agents');
    const row = (await screen.findByRole('link', { name: 'cve-triage' })).closest('tr')!;
    expect(within(row).getByLabelText('Never run')).toBeInTheDocument();
    expect(within(row).getByLabelText('No budget')).toBeInTheDocument();
    expect(within(row).getByLabelText('No use case')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
  });

  it('computes attention reasons', () => {
    const base = f.draftOnlyAgent;
    expect(attentionReasons(base)).toEqual([]);
    expect(
      attentionReasons({ ...base, lastRun: { id: 'x', status: 'failed', createdAt: '' } }),
    ).toEqual(['lastRun']);
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    expect(attentionReasons({ ...base, status: 'changed', draftUpdatedAt: old })).toEqual([
      'changed',
    ]);
    expect(attentionReasons({ ...base, status: 'changed' })).toEqual([]);
  });

  it('renders the German labels', async () => {
    await renderApp('/agents', { locale: 'de' });
    await heading('Agenten');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Owner-Team' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Use Case' })).toBeInTheDocument();
    expect(within(table).getByText('Geändert')).toBeInTheDocument();
    expect(within(table).getByText('Entwurf')).toBeInTheDocument();
  });

  it('shows the tenant path as tooltip and keeps the demo tree readable', async () => {
    useTree(
      tree().map((a) => ({
        ...a,
        tenant: {
          id: 't-sec',
          slug: 'security',
          name: 'Security',
          slugPath: 'example-org/security',
        },
      })),
    );
    await renderApp('/agents');
    await heading('Agents');
    const chips = await screen.findAllByRole('group', { name: 'Tenant: Security' });
    expect(chips[0]).toHaveAttribute('title', 'Tenant: Security (example-org/security)');
    expect(screen.getByRole('link', { name: 'release-watch' })).toBeInTheDocument();
    await expectNoA11yViolations();
  });
});

describe('agents list v2: filters and URL state', () => {
  it('applies the status filter, writes it to the URL and follows back/forward', async () => {
    useTree();
    const { user, router } = await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByRole('link', { name: 'cve-triage' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    await waitFor(() => expect(names()).toEqual(['feature-builder']));
    expect(router.state.location.search).toEqual({ status: 'draft' });
    act(() => router.history.back());
    await waitFor(() => expect(names().length).toBe(5));
    expect(screen.getByLabelText('Status')).toHaveValue('');
    act(() => router.history.forward());
    await waitFor(() => expect(names()).toEqual(['feature-builder']));
    expect(screen.getByLabelText('Status')).toHaveValue('draft');
  });

  it('is deep-linkable: filters in the URL are applied and shown in the controls', async () => {
    useTree();
    await renderApp(`/agents?status=published&teamId=${prod.id}&useCase=software-factory&q=docs`);
    await heading('Agents');
    await waitFor(() => expect(names()).toEqual(['docs-helper']));
    expect(screen.getByLabelText('Status')).toHaveValue('published');
    expect(screen.getByLabelText('Use case')).toHaveValue('software-factory');
    expect(screen.getByRole('searchbox')).toHaveValue('docs');
    expect(screen.getByLabelText('Owner team')).toHaveValue(prod.id);
  });

  it('filters by owner team and by use case (sub-use cases included)', async () => {
    useTree();
    const { user, router } = await renderApp('/agents');
    await heading('Agents');
    await screen.findByRole('link', { name: 'cve-triage' });
    await user.selectOptions(screen.getByLabelText('Owner team'), f.ids.team);
    // The fixture team has no agents in this tree: nothing matches, and the page says so.
    expect(await screen.findByText('No agents match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(names().length).toBe(5));
    const useCase = screen.getByLabelText('Use case');
    await user.type(useCase, 'software-factory{Enter}');
    await waitFor(() => expect(names().sort()).toEqual(['docs-helper', 'feature-builder']));
    expect(router.state.location.search).toEqual({ useCase: 'software-factory' });
  });

  it('debounces the search into the URL and restores it from the URL on back', async () => {
    useTree();
    const { user, router } = await renderApp('/agents');
    await heading('Agents');
    await screen.findByRole('link', { name: 'cve-triage' });
    await user.type(screen.getByRole('searchbox'), 'review');
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'review' }));
    await waitFor(() => expect(names()).toEqual(['hardening-review']));
    await user.selectOptions(screen.getByLabelText('Status'), 'changed');
    expect(router.state.location.search).toEqual({ q: 'review', status: 'changed' });
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'review' }));
    expect(screen.getByRole('searchbox')).toHaveValue('review');
    expect(screen.getByLabelText('Status')).toHaveValue('');
    // A URL change from outside (e.g. a link) flows back into the input.
    await act(() => router.navigate({ to: '/agents', search: { q: 'docs' } }));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue('docs'));
    await waitFor(() => expect(names()).toEqual(['docs-helper']));
  });

  it('ignores invalid search params', async () => {
    useTree();
    const { router } = await renderApp('/agents?status=bogus&groupBy=nope');
    await heading('Agents');
    await waitFor(() => expect(names().length).toBe(5));
    expect(router.state.location.search).toEqual({});
  });

  it('keeps the filter controls keyboard operable', async () => {
    useTree();
    const { user } = await renderApp('/agents');
    await heading('Agents');
    await screen.findByRole('link', { name: 'cve-triage' });
    await user.click(screen.getByRole('searchbox'));
    await user.tab();
    expect(screen.getByLabelText('Status')).toHaveFocus();
    await user.selectOptions(screen.getByLabelText('Status'), 'published');
    await waitFor(() => expect(names().length).toBe(3));
    await user.tab();
    expect(screen.getByLabelText('Owner team')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Use case')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Group by')).toHaveFocus();
  });
});

describe('agents list v2: group by', () => {
  it('groups by use case under headed row groups, "no use case" last, and keeps it in the URL', async () => {
    useTree();
    const { user, router } = await renderApp('/agents');
    await heading('Agents');
    await screen.findByRole('link', { name: 'cve-triage' });
    await user.selectOptions(screen.getByLabelText('Group by'), 'useCase');
    expect(router.state.location.search).toEqual({ groupBy: 'useCase' });
    const heads = await screen.findAllByRole('heading', { level: 2 });
    expect(heads.map((h) => h.textContent)).toEqual([
      'governance (1)',
      'software-factory (1)',
      'software-factory/docs (1)',
      'vulnerability-management (1)',
      'No use case (1)',
    ]);
    const group = screen.getByRole('rowgroup', { name: /^governance/ });
    expect(within(group).getByRole('link', { name: 'hardening-review' })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('groups by owner team from a deep link', async () => {
    useTree();
    await renderApp('/agents?groupBy=ownerTeam');
    await heading('Agents');
    const heads = await screen.findAllByRole('heading', { level: 2 });
    expect(heads.map((h) => h.textContent)).toEqual(['Product (2)', 'Security (2)', 'No team (1)']);
    expect(screen.getByLabelText('Group by')).toHaveValue('ownerTeam');
  });

  it('groups card rows on phones with sticky headings', async () => {
    setPhone(true);
    useTree();
    await renderApp('/agents?groupBy=ownerTeam');
    await heading('Agents');
    const section = await screen.findByRole('region', { name: 'Security' });
    expect(
      within(section).getByRole('heading', { level: 2, name: 'Security (2)' }),
    ).toBeInTheDocument();
    const list = within(section).getByRole('list', { name: 'Agents: Security' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await expectNoA11yViolations();
  });
});

describe('agents list v2: paging, loading, empty and error states', () => {
  it('loads more with the keyset cursor', async () => {
    const many = Array.from({ length: 60 }, (_, i) => agent({ name: `agent-${i}` }));
    const cursors: (string | null)[] = [];
    const handler = agentsList(many);
    server.use(
      http.get(api('/v1/agents'), (info) => {
        cursors.push(new URL(info.request.url).searchParams.get('cursor'));
        return handler(info);
      }),
    );
    const { user } = await renderApp('/agents');
    await heading('Agents');
    expect((await screen.findAllByText('50 loaded')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findAllByText('60 agents')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(cursors).toEqual([null, '50']);
  });

  it('loads more on phones too', async () => {
    setPhone(true);
    const many = Array.from({ length: 55 }, (_, i) => agent({ name: `agent-${i}` }));
    server.use(http.get(api('/v1/agents'), agentsList(many)));
    const { user } = await renderApp('/agents');
    await heading('Agents');
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect((await screen.findAllByText('55 agents')).length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem'),
    ).toHaveLength(55);
  });

  it('shows a skeleton while loading', async () => {
    server.use(
      http.get(api('/v1/agents'), async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({ items: [f.agent], nextCursor: null });
      }),
    );
    await renderApp('/agents');
    await heading('Agents');
    const status = (await screen.findByText('Loading…')).closest('[aria-busy]')!;
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('role', 'status');
    await expectNoA11yViolations();
    expect(await screen.findByRole('link', { name: 'ticket-updater' })).toBeInTheDocument();
  });

  it('explains "no agents match" and clears the filters', async () => {
    useTree();
    const { user, router } = await renderApp('/agents?q=nothing-like-this&groupBy=useCase');
    await heading('Agents');
    expect(await screen.findByText('No agents match these filters')).toBeInTheDocument();
    expect(screen.queryByText(/no agents in/i)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await waitFor(() => expect(router.state.location.search).toEqual({ groupBy: 'useCase' }));
    expect(await screen.findByRole('link', { name: 'cve-triage' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('tells a writer the tenant is empty and offers the next step', async () => {
    server.use(
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByText('No agents in Acme yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'New agent' }).length).toBe(2);
  });

  it('tells a read-only user that nothing is visible, without implying hidden data', async () => {
    asViewer();
    server.use(
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByText('No agents visible to you in Acme')).toBeInTheDocument();
    expect(screen.getByText(/ask a tenant admin of Acme/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New agent' })).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('shows errors with a retry that works', async () => {
    let fail = true;
    server.use(
      http.get(api('/v1/agents'), (info) =>
        fail
          ? HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 })
          : agentsList([f.agent])(info),
      ),
    );
    const { user } = await renderApp('/agents');
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'ticket-updater' })).toBeInTheDocument();
  });

  it('shows a permission message on 403', async () => {
    server.use(
      http.get(api('/v1/agents'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'no' }, { status: 403 }),
      ),
    );
    await renderApp('/agents');
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i);
  });
});
