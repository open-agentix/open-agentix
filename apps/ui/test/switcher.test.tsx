import { act, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary } from '../src/api/types';
import { authHeaders } from '../src/api/client';
import { session } from '../src/auth/session';
import { activeTenant } from '../src/lib/activeTenant';
import { MAX_RECENT, pushRecent, readRecent } from '../src/features/tenancy/recent';
import * as f from './fixtures';
import { agentsList, api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp, signIn } from './utils';

const org = {
  id: 'c0000000-0000-4000-8000-000000000001',
  slug: 'example-org',
  name: 'Example Org',
};
const sec = { id: 'c0000000-0000-4000-8000-000000000002', slug: 'security', name: 'Security' };
const plat = { id: 'c0000000-0000-4000-8000-000000000003', slug: 'platform', name: 'Platform' };
const all = [org, sec, plat];
const row = (t: (typeof all)[number]) => ({
  ...t,
  monthlyBudgetUsd: null,
  secretRefs: [],
  createdAt: f.tenantRow.createdAt,
});

let n = 0;
function agent(name: string, t: (typeof all)[number], slugPath: string): AgentSummary {
  n += 1;
  return {
    ...f.agent,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name,
    description: null,
    lastRun: null,
    budget: null,
    tenant: { ...t, slugPath },
  };
}
const byTenant: Record<string, AgentSummary[]> = {
  [org.id]: [agent('release-watch', org, 'example-org')],
  [sec.id]: [agent('cve-triage', sec, 'example-org/security')],
  [plat.id]: [agent('feature-builder', plat, 'example-org/platform')],
};

/** What the API does for a platform admin: lists all tenants, honours and echoes X-OAX-Tenant. */
function platformAdmin(opts: { agentDelayMs?: number; tenants?: typeof all } = {}) {
  const seen: { path: string; tenant: string | null }[] = [];
  const known = opts.tenants ?? all;
  const acting = (req: Request) => {
    const h = req.headers.get('x-oax-tenant');
    return { header: h, tenant: h ? all.find((t) => t.id === h || t.slug === h) : org };
  };
  server.use(
    http.get(api('/v1/tenants'), () => HttpResponse.json({ items: known.map(row) })),
    http.get(api('/v1/me'), ({ request }) => {
      const { header, tenant } = acting(request);
      seen.push({ path: '/v1/me', tenant: header });
      if (!tenant)
        return HttpResponse.json(
          { error: 'not_found', message: 'tenant not found' },
          { status: 404 },
        );
      return HttpResponse.json({
        ...f.meAdmin,
        user: { ...f.adminUser, tenantId: org.id },
        platformAdmin: true,
        tenant,
      });
    }),
    http.get(api('/v1/agents'), async ({ request, ...rest }) => {
      const { header, tenant } = acting(request);
      seen.push({ path: '/v1/agents', tenant: header });
      if (opts.agentDelayMs) await delay(opts.agentDelayMs);
      if (!tenant)
        return HttpResponse.json(
          { error: 'not_found', message: 'tenant not found' },
          { status: 404 },
        );
      return agentsList(byTenant[tenant.id] ?? [])({ request, ...rest });
    }),
  );
  return seen;
}

const triggers = () => screen.getAllByRole('button', { name: /^Switch tenant\. Current:/ });

async function openSwitcher(user: Awaited<ReturnType<typeof renderApp>>['user']) {
  await screen.findAllByRole('button', { name: /^Switch tenant\. Current:/ });
  await user.click(triggers()[0]!);
  return screen.findByRole('combobox', { name: 'Search tenants by name or slug' });
}

beforeEach(() => {
  activeTenant.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('tenant switcher visibility', () => {
  it('is hidden for a principal that can act in one tenant and keeps the static tile', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    const badges = await screen.findAllByRole('group', { name: 'Active tenant' });
    expect(badges.length).toBe(2);
    expect(screen.queryByRole('button', { name: /^Switch tenant/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Tenant path' })).not.toBeInTheDocument();
  });

  it('is shown for a principal with several tenants, in the top bar and the sidebar', async () => {
    platformAdmin();
    await renderApp('/');
    await heading(/hello ada admin/i);
    await waitFor(() => expect(triggers().length).toBe(2));
    expect(screen.queryByRole('group', { name: 'Active tenant' })).not.toBeInTheDocument();
  });

  it('is localised', async () => {
    platformAdmin();
    await renderApp('/', { locale: 'de' });
    expect(
      (await screen.findAllByRole('button', { name: 'Tenant wechseln. Aktuell: Example Org' }))
        .length,
    ).toBe(2);
  });
});

describe('tenant switcher interaction', () => {
  it('switches with the keyboard only: search, arrow keys, Enter, announcement, focus', async () => {
    const seen = platformAdmin();
    const { user } = await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByText('release-watch', {}, { timeout: 5000 })).toBeInTheDocument();

    triggers()[0]!.focus();
    await user.keyboard('{Enter}');
    const box = await screen.findByRole('combobox', { name: 'Search tenants by name or slug' });
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('sec');
    const options = within(screen.getByRole('listbox', { name: 'Switch tenant' })).getAllByRole(
      'option',
    );
    expect(options).toHaveLength(1);
    expect(box).toHaveAttribute('aria-activedescendant', options[0]!.id);
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Switched to Security')).toBeInTheDocument();
    expect(await screen.findByText('cve-triage', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('release-watch')).not.toBeInTheDocument();
    // every call after the switch carries the header; calls before it do not
    const after = seen.filter((s) => s.tenant !== null);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.tenant === sec.id)).toBe(true);
    expect(seen.some((s) => s.path === '/v1/agents' && s.tenant === null)).toBe(true);
    await waitFor(() => expect(document.querySelector('main h1')).toHaveFocus());
    expect(screen.getAllByRole('button', { name: 'Switch tenant. Current: Security' }).length).toBe(
      2,
    );
  });

  it('moves with arrow keys (wrapping), marks the current tenant and closes with Escape', async () => {
    platformAdmin();
    const { user } = await renderApp('/');
    const box = await openSwitcher(user);
    // alphabetical: Example Org, Platform, Security; the highlight starts on the current tenant
    const list = () => within(screen.getByRole('listbox', { name: 'Switch tenant' }));
    const names = () =>
      list()
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(names()[0]).toContain('Example Org');
    const current = list()
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(within(current[0]!).getByText('current tenant')).toBeInTheDocument();
    const selected = () =>
      list()
        .getAllByRole('option')
        .find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(selected().textContent).toContain('Example Org');
    await user.keyboard('{ArrowDown}');
    expect(selected().textContent).toContain('Platform');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected().textContent).toContain('Security');
    await user.keyboard('{Home}');
    expect(selected().textContent).toContain('Example Org');
    await user.keyboard('{End}');
    expect(selected().textContent).toContain('Security');
    expect(box).toHaveAttribute('aria-activedescendant', selected().id);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Switch tenant' })).not.toBeInTheDocument();
    expect(triggers()[0]).toHaveFocus();
  });

  it('shows an empty state and keeps the tenant when nothing matches or the current one is chosen', async () => {
    const seen = platformAdmin();
    const { user } = await renderApp('/');
    await openSwitcher(user);
    await user.keyboard('zzz');
    expect(screen.getByText('No tenant matches "zzz"')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Switch tenant' })).toBeInTheDocument();
    await user.clear(screen.getByRole('combobox', { name: 'Search tenants by name or slug' }));
    await user.click(
      within(screen.getByRole('listbox', { name: 'Switch tenant' }))
        .getAllByRole('option')
        .find((o) => o.textContent?.includes('Example Org'))!,
    );
    expect(screen.queryByRole('dialog', { name: 'Switch tenant' })).not.toBeInTheDocument();
    expect(activeTenant.get()).toBeNull();
    expect(seen.every((s) => s.tenant === null)).toBe(true);
  });

  it('closes on an outside click and passes axe', async () => {
    platformAdmin();
    const { user } = await renderApp('/');
    await openSwitcher(user);
    await expectNoA11yViolations();
    await user.click(document.body);
    expect(screen.queryByRole('dialog', { name: 'Switch tenant' })).not.toBeInTheDocument();
  });

  it('lists recent tenants per user and keeps at most five', async () => {
    platformAdmin();
    const { user } = await renderApp('/');
    const box = await openSwitcher(user);
    await user.keyboard('plat{Enter}');
    expect(await screen.findByText('Switched to Platform')).toBeInTheDocument();
    expect(localStorage.getItem(`oax.recentTenants.${f.adminUser.id}`)).toBe(
      JSON.stringify([plat.id]),
    );

    await user.click(triggers()[0]!);
    expect(box).not.toBe(null);
    const recent = await screen.findByRole('group', { name: 'Recent' });
    expect(within(recent).getAllByRole('option')).toHaveLength(1);
    expect(within(recent).getByText('Platform')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'All tenants' })).toBeInTheDocument();
  });

  it('works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => pushRecent('u-blocked', 'a')).not.toThrow();
    expect(readRecent('u-blocked')).toEqual(['a']);
    activeTenant.set(sec);
    expect(activeTenant.header()).toBe(sec.id);
    activeTenant.clear();
  });
});

describe('recent list', () => {
  it('moves a tenant to the front, deduplicates and caps at five', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) pushRecent('u1', id);
    expect(readRecent('u1')).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(readRecent('u1')).toHaveLength(MAX_RECENT);
    expect(readRecent('u2')).toEqual([]);
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('oax.recentTenants.u3', '{not json');
    expect(readRecent('u3')).toEqual([]);
    localStorage.setItem('oax.recentTenants.u3', JSON.stringify([1, 'x', null]));
    expect(readRecent('u3')).toEqual(['x']);
  });
});

describe('cache separation and header propagation', () => {
  it('shows no row of the previous tenant while the next tenant loads', async () => {
    platformAdmin({ agentDelayMs: 150 });
    const { user, queryClient } = await renderApp('/agents');
    expect(await screen.findByText('release-watch', {}, { timeout: 5000 })).toBeInTheDocument();
    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    // from the first moment after the switch the old row is gone; the new one arrives later
    expect(screen.queryByText('release-watch')).not.toBeInTheDocument();
    expect(await screen.findByText('cve-triage', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('release-watch')).not.toBeInTheDocument();
    // nothing of tenant A is left in the query cache either
    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[0] !== 'tenants')
        .map((q) => q.state.data ?? null),
    );
    expect(cached).not.toContain('release-watch');
    expect(cached).toContain('cve-triage');
  });

  it('does not store the late answer of a request that started before the switch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const seen = platformAdmin();
    server.use(
      http.get(api('/v1/agents'), async ({ request, ...rest }) => {
        const h = request.headers.get('x-oax-tenant');
        seen.push({ path: '/v1/agents', tenant: h });
        if (!h) await gate; // the first tenant answers slowly
        return agentsList(byTenant[h ?? org.id] ?? [])({ request, ...rest });
      }),
    );
    const { user } = await renderApp('/agents');
    await heading('Agents');
    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    expect(await screen.findByText('cve-triage', {}, { timeout: 5000 })).toBeInTheDocument();
    await act(async () => release?.());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('release-watch')).not.toBeInTheDocument();
    expect(screen.getByText('cve-triage')).toBeInTheDocument();
  });

  it('sends the header from authHeaders only with a session', () => {
    session.clear();
    activeTenant.set(sec);
    expect(authHeaders()['x-oax-tenant']).toBeUndefined();
    session.set('oax_t', new Date(Date.now() + 60_000).toISOString());
    // a new session never inherits the previous choice
    expect(activeTenant.get()).toBeNull();
    activeTenant.set(sec);
    expect(authHeaders()).toMatchObject({ authorization: 'Bearer oax_t', 'x-oax-tenant': sec.id });
    session.clear();
    expect(activeTenant.get()).toBeNull();
  });

  it('refuses values that are not tenant ids or slugs', () => {
    expect(() => activeTenant.set({ id: 'x\r\nhost: evil', slug: 's', name: 'n' })).toThrow();
    expect(() => activeTenant.set({ id: '', slug: 's', name: 'n' })).toThrow();
    expect(activeTenant.get()).toBeNull();
  });

  it('never keeps the token or the tenant in localStorage', async () => {
    platformAdmin();
    const { user } = await renderApp('/');
    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    await screen.findByText('Switched to Security');
    const dump = JSON.stringify({ ...localStorage });
    expect(dump).not.toContain('oax_test_session_token');
    expect(localStorage.getItem('oax.tenant')).toBeNull();
    expect(sessionStorage.getItem('oax.tenant')).toContain(sec.id);
  });
});

describe('persistence and stale tenants', () => {
  it('keeps the choice for the tab session across a reload', async () => {
    const seen = platformAdmin();
    const first = await renderApp('/agents');
    await first.user.click(
      (await screen.findAllByRole('button', { name: /^Switch tenant\./ }))[0]!,
    );
    await first.user.keyboard('plat{Enter}');
    expect(await screen.findByText('feature-builder', {}, { timeout: 5000 })).toBeInTheDocument();
    first.unmount();

    seen.length = 0;
    // a reload keeps the tab's sessionStorage (token and tenant); no new sign-in happens
    await renderApp('/agents', { signedIn: false });
    expect(await screen.findByText('feature-builder', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(seen.every((s) => s.tenant === plat.id)).toBe(true);
    expect(
      (await screen.findAllByRole('button', { name: 'Switch tenant. Current: Platform' })).length,
    ).toBe(2);
  });

  it('falls back to the home tenant with a message when the remembered tenant is refused', async () => {
    const seen = platformAdmin();
    signIn();
    sessionStorage.setItem(
      'oax.tenant',
      JSON.stringify({ id: 'c0000000-0000-4000-8000-0000000000ff', slug: 'gone', name: 'Gone' }),
    );
    await renderApp('/agents', { signedIn: false });
    expect(await screen.findByText('release-watch', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    expect(sessionStorage.getItem('oax.tenant')).toBeNull();
    expect(
      (await screen.findAllByRole('button', { name: 'Switch tenant. Current: Example Org' }))
        .length,
    ).toBe(2);
    expect(seen.some((s) => s.tenant === null && s.path === '/v1/agents')).toBe(true);
  });

  it('falls back when a later call is refused for the tenant', async () => {
    platformAdmin();
    const { user } = await renderApp('/agents');
    await openSwitcher(user);
    server.use(
      http.get(api('/v1/agents'), () =>
        HttpResponse.json({ error: 'not_found', message: 'tenant not found' }, { status: 404 }),
      ),
    );
    await user.keyboard('sec{Enter}');
    await waitFor(() => expect(activeTenant.get()).toBeNull());
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
  });

  it('leaves an item page of the previous tenant for its list', async () => {
    platformAdmin();
    server.use(http.get(api('/v1/agents/:id'), () => HttpResponse.json(f.agent)));
    const { user, router } = await renderApp(`/agents/${f.ids.agent}`);
    await screen.findAllByRole('button', { name: /^Switch tenant\./ });
    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
  });
});

describe('breadcrumb and confirmations', () => {
  it('shows the tenant path and the acting-in label outside the home tenant', async () => {
    platformAdmin();
    const { user } = await renderApp('/agents');
    expect(await screen.findByText('release-watch', {}, { timeout: 5000 })).toBeInTheDocument();
    let crumbs = await screen.findByRole('navigation', { name: 'Tenant path' });
    expect(within(crumbs).getByText('Agents')).toHaveAttribute('aria-current', 'page');
    expect(within(crumbs).queryByText(/Acting in/)).not.toBeInTheDocument();

    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    expect(await screen.findByText('cve-triage', {}, { timeout: 5000 })).toBeInTheDocument();
    crumbs = await screen.findByRole('navigation', { name: 'Tenant path' });
    await waitFor(() => expect(within(crumbs).getByText('example-org')).toBeInTheDocument());
    expect(within(crumbs).getByText('Security')).toBeInTheDocument();
    expect(within(crumbs).getByText('Acting in Security')).toBeInTheDocument();
    expect(crumbs).toHaveAttribute('data-acting', 'true');
  });

  it('names the target tenant in write confirmations', async () => {
    platformAdmin();
    server.use(http.get(api('/v1/tokens'), () => HttpResponse.json({ items: [f.tokens[0]!] })));
    const { user } = await renderApp('/tokens');
    await openSwitcher(user);
    await user.keyboard('sec{Enter}');
    await screen.findByText('Switched to Security');
    await user.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    const target = within(dialog).getByTestId('confirm-target');
    await waitFor(() => expect(target).toHaveTextContent('Target tenant: Security'));
  });
});
