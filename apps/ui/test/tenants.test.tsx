import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeTenant } from '../src/lib/activeTenant';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

const ids = f.treeIds;
const tenantOf = (id: string, slug: string, name: string) => ({ id, slug, name });
const org = tenantOf(ids.org, 'example-org', 'Example Org');
const sec = tenantOf(ids.sec, 'security', 'Security');

/** A platform operator: reaches every node, home tenant is the organisation root. */
function asPlatformAdmin(items = f.platformTree, truncated = false) {
  const nodes = (items.length ? items : f.platformTree).filter((n) => n.visible);
  server.use(
    http.get(api('/v1/me'), ({ request }) => {
      const h = request.headers.get('x-oax-tenant');
      const acting = nodes.find((n) => n.id === h) ?? nodes[0]!;
      return HttpResponse.json({
        ...f.meAdmin,
        user: { ...f.adminUser, tenantId: org.id },
        tenant: tenantOf(acting.id, acting.slug, acting.name),
        actingTenant: {
          ...tenantOf(acting.id, acting.slug, acting.name),
          slugPath: acting.slugPath,
          path: [tenantOf(acting.id, acting.slug, acting.name)],
        },
        homeTenant: { ...org, slugPath: 'example-org' },
        platformAdmin: true,
        installationMode: 'multi',
        visibleTenantCount: nodes.length,
      });
    }),
    http.get(api('/v1/tenants'), () =>
      HttpResponse.json({
        items: nodes.map((n) => ({
          id: n.id,
          slug: n.slug,
          name: n.name,
          slugPath: n.slugPath,
          parentId: n.parentId,
          depth: n.depth,
          monthlyBudgetUsd: null,
          secretRefs: [],
          createdAt: f.tenantRow.createdAt,
        })),
      }),
    ),
    http.get(api('/v1/tenants/tree'), () => HttpResponse.json({ items, truncated })),
  );
}

/** A tenant admin of `security` below `example-org/eu`: own node plus ancestors as path stubs. */
function asTenantAdminBelow() {
  server.use(
    http.get(api('/v1/me'), () =>
      HttpResponse.json({
        ...f.meAdmin,
        user: { ...f.adminUser, tenantId: sec.id },
        tenant: sec,
        actingTenant: { ...sec, slugPath: 'example-org/eu/security', path: [org, sec] },
        homeTenant: { ...sec, slugPath: 'example-org/eu/security' },
        platformAdmin: false,
        installationMode: 'single',
        visibleTenantCount: 1,
      }),
    ),
    http.get(api('/v1/tenants'), () =>
      HttpResponse.json({
        items: [
          {
            ...sec,
            slugPath: 'example-org/eu/security',
            parentId: ids.eu,
            depth: 2,
            monthlyBudgetUsd: null,
            secretRefs: [],
            createdAt: f.tenantRow.createdAt,
          },
        ],
      }),
    ),
    http.get(api('/v1/tenants/tree'), () =>
      HttpResponse.json({ items: f.stubbedTree, truncated: false }),
    ),
  );
}

const grid = () => screen.findByRole('treegrid', { name: 'Tenant tree' }, { timeout: 5000 });
const rowOf = (name: string) => {
  const row = screen
    .getAllByRole('row')
    .find((r) => within(r).queryByText(name, { selector: '.tenant-row-name' }));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
const rowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('.tenant-row-name')?.textContent);

function phone(on: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('max-width: 600px'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

beforeEach(() => {
  activeTenant.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('tenants navigation entry', () => {
  it('is hidden for a single tenant with no ancestors', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(screen.queryByRole('link', { name: 'Tenants' })).not.toBeInTheDocument();
  });

  it('is shown in multi mode', async () => {
    asPlatformAdmin();
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(await screen.findByRole('link', { name: 'Tenants' })).toHaveAttribute(
      'href',
      '/tenants',
    );
  });

  it('is shown for a tenant below others (the tree has more than one node)', async () => {
    asTenantAdminBelow();
    await renderApp('/');
    await heading(/hello ada admin/i);
    expect(await screen.findByRole('link', { name: 'Tenants' })).toBeInTheDocument();
  });
});

describe('tenant tree', () => {
  it('shows two levels open, with levels, expandable state and a skeleton while loading', async () => {
    asPlatformAdmin();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(api('/v1/tenants/tree'), async () => {
        await gate;
        return HttpResponse.json({ items: f.platformTree, truncated: false });
      }),
    );
    await renderApp('/tenants');
    await heading('Tenants');
    expect(await screen.findByRole('status', { busy: true })).toBeInTheDocument();
    release();
    await grid();
    expect(rowNames()).toEqual(['Example Org', 'Platform', 'Security']);
    expect(rowOf('Example Org')).toHaveAttribute('aria-level', '1');
    expect(rowOf('Example Org')).toHaveAttribute('aria-expanded', 'true');
    expect(rowOf('Security')).toHaveAttribute('aria-level', '2');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'false');
    expect(rowOf('Platform')).not.toHaveAttribute('aria-expanded');
    expect(document.title).toContain('Tenants');
  });

  it('walks the tree with the keyboard: arrows, Home/End, expand, collapse, * and +/-', async () => {
    asPlatformAdmin();
    const { user } = await renderApp('/tenants');
    await grid();
    const org = rowOf('Example Org');
    expect(org).toHaveAttribute('tabindex', '0');
    org.focus();

    await user.keyboard('{ArrowDown}');
    expect(rowOf('Platform')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rowOf('Security')).toHaveFocus();
    await user.keyboard('{ArrowDown}'); // last row stays
    expect(rowOf('Security')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rowOf('Example Org')).toHaveFocus();
    await user.keyboard('{End}');
    expect(rowOf('Security')).toHaveFocus();

    // Right opens a closed node, a second Right moves to its first child
    await user.keyboard('{ArrowRight}');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'true');
    expect(rowNames()).toEqual(['Example Org', 'Platform', 'Security', 'Product']);
    await user.keyboard('{ArrowRight}');
    expect(rowOf('Product')).toHaveFocus();
    // Left on a leaf goes to the parent, Left on an open node closes it
    await user.keyboard('{ArrowLeft}');
    expect(rowOf('Security')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('+');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('-');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'false');

    // * opens all siblings on the level of the focused node
    await user.keyboard('*');
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'true');
    expect(rowNames()).toContain('Product');
    // roving tabindex: exactly one row is a tab stop
    expect(
      screen.getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
  });

  it('expands and collapses with the mouse toggle', async () => {
    asPlatformAdmin();
    const { user } = await renderApp('/tenants');
    await grid();
    await user.click(screen.getByRole('button', { name: 'Expand Security' }));
    expect(rowNames()).toContain('Product');
    await user.click(screen.getByRole('button', { name: 'Collapse Security' }));
    expect(rowNames()).not.toContain('Product');
  });

  it('shows counts compactly, null as a dash with a "Not permitted" text and never as 0', async () => {
    asPlatformAdmin();
    await renderApp('/tenants');
    await grid();
    const org = within(rowOf('Example Org'));
    expect(org.getByText('1 (6)')).toBeInTheDocument();
    expect(org.getAllByText('12')).toHaveLength(2); // visible text and its screen-reader twin
    expect(org.getByText('$118 ($240) / $300')).toBeInTheDocument();
    // the Product subtree
    const sec = within(rowOf('Security'));
    expect(sec.getByText('3 (5)')).toBeInTheDocument();
    expect(sec.getByText('4 approvals pending')).toBeInTheDocument();
  });

  it('keeps a null count apart from 0 for a tenant admin below others', async () => {
    asTenantAdminBelow();
    await renderApp('/tenants');
    await grid();
    const own = within(rowOf('Security'));
    // pending approvals and spend are null: dash + text, no "0"
    const cells = own.getAllByRole('gridcell');
    const pending = cells[3]!;
    const spend = cells[2]!;
    expect(pending).toHaveTextContent('–');
    expect(within(pending).getByText('Not permitted')).toBeInTheDocument();
    expect(pending).not.toHaveTextContent(/\b0\b/);
    expect(within(spend).getByText('Not permitted')).toBeInTheDocument();
    expect(within(spend).queryByRole('meter')).not.toBeInTheDocument();
    // a permitted count is shown as a number
    expect(cells[0]).toHaveTextContent('3');
  });

  it('draws a budget bar only when spend and cap are both present', async () => {
    asPlatformAdmin();
    await renderApp('/tenants');
    await grid();
    const bar = within(rowOf('Example Org')).getByRole('meter');
    expect(bar).toHaveAccessibleName('Spend this month: $118 of $300');
    expect(bar).toHaveAttribute('aria-valuenow', '118');
    expect(bar).toHaveAttribute('aria-valuemax', '300');
    // Platform has spend but no cap: no bar, text says so
    const plat = within(rowOf('Platform'));
    expect(plat.queryByRole('meter')).not.toBeInTheDocument();
    expect(plat.getByText('$22. No cap shown')).toBeInTheDocument();
  });

  it('labels direct and inherited roles with text and an explanation', async () => {
    asPlatformAdmin();
    await renderApp('/tenants');
    await grid();
    const direct = within(rowOf('Example Org'));
    expect(direct.getByText('Tenant admin')).toBeInTheDocument();
    expect(direct.getByText('Bound directly on this tenant.')).toBeInTheDocument();
    const inherited = within(rowOf('Security'));
    expect(inherited.getByText('(inherited)')).toBeInTheDocument();
    const hint = inherited.getByText('Inherited from a binding on a tenant above this one.');
    expect(hint.closest('[title]')).toHaveAttribute(
      'title',
      'Inherited from a binding on a tenant above this one.',
    );
    expect(inherited.getByText('Platform admin')).toBeInTheDocument();
  });

  it('shows a blocked node with a text badge', async () => {
    const tree = f.platformTree.map((n) =>
      n.slug === 'platform' ? { ...n, status: 'blocked' as const } : n,
    );
    asPlatformAdmin(tree);
    await renderApp('/tenants');
    await grid();
    expect(within(rowOf('Platform')).getByText('Blocked')).toBeInTheDocument();
  });
});

describe('truncated tree and permission-aware states', () => {
  it('announces a truncated tree', async () => {
    asPlatformAdmin(f.platformTree, true);
    await renderApp('/tenants');
    await grid();
    expect(
      screen.getByText('Showing only the first 4 tenants. Search to find the others.'),
    ).toBeInTheDocument();
  });

  it('says that only the own tenant is visible and shows the ancestors as path stubs', async () => {
    asTenantAdminBelow();
    await renderApp('/tenants');
    await grid();
    expect(screen.getByText('You can only see your own tenant.')).toBeInTheDocument();
    expect(rowNames()).toEqual(['Example Org', 'EU', 'Security']);
    const stub = within(rowOf('Example Org'));
    expect(stub.getByText('Path only')).toBeInTheDocument();
    expect(stub.queryByText('Tenant admin')).not.toBeInTheDocument();
    expect(rowOf('Security')).toHaveAttribute('aria-level', '3');
  });

  it('does not show the own-tenant note to a platform operator', async () => {
    asPlatformAdmin();
    await renderApp('/tenants');
    await grid();
    expect(screen.queryByText('You can only see your own tenant.')).not.toBeInTheDocument();
  });

  it('shows an empty state and an error state with retry', async () => {
    asPlatformAdmin([]);
    const first = await renderApp('/tenants');
    expect(await screen.findByText('No tenants to show.')).toBeInTheDocument();
    first.unmount();

    let fail = true;
    server.use(
      http.get(api('/v1/tenants/tree'), () =>
        fail
          ? HttpResponse.json({ error: 'internal', message: 'boom' }, { status: 500 })
          : HttpResponse.json({ items: f.platformTree, truncated: false }),
      ),
    );
    const { user } = await renderApp('/tenants');
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await grid()).toBeInTheDocument();
  });
});

describe('switching', () => {
  it('switches to a tenant with the button and keeps the tree', async () => {
    asPlatformAdmin();
    const { user, queryClient } = await renderApp('/tenants');
    await grid();
    const row = within(rowOf('Security'));
    await user.click(row.getByRole('button', { name: 'Switch to Security' }));
    expect(await screen.findAllByText('Switched to Security')).not.toHaveLength(0);
    expect(activeTenant.get()?.id).toBe(ids.sec);
    await waitFor(() =>
      expect(within(rowOf('Security')).getByText('Current tenant')).toBeInTheDocument(),
    );
    expect(rowOf('Security')).toHaveAttribute('aria-current', 'true');
    // the tree belongs to the user, not to a tenant: it survives the cache reset of the switch
    expect(queryClient.getQueryData(['tenants', 'tree'])).toBeDefined();
    // the current row offers no second switch
    expect(
      within(rowOf('Security')).queryByRole('button', { name: /^Switch to/ }),
    ).not.toBeInTheDocument();
  });

  it('switches with Enter on a row', async () => {
    asPlatformAdmin();
    const { user } = await renderApp('/tenants');
    await grid();
    rowOf('Platform').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(activeTenant.get()?.id).toBe(ids.plat));
    expect(await screen.findAllByText('Switched to Platform')).not.toHaveLength(0);
  });

  it('keeps data requests on the new tenant: later calls carry the header', async () => {
    asPlatformAdmin();
    const headers: (string | null)[] = [];
    server.use(
      http.get(api('/v1/agents'), ({ request }) => {
        headers.push(request.headers.get('x-oax-tenant'));
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { user, router } = await renderApp('/tenants');
    await grid();
    await user.click(within(rowOf('Platform')).getByRole('button', { name: 'Switch to Platform' }));
    await waitFor(() => expect(activeTenant.get()?.id).toBe(ids.plat));
    await act(async () => {
      await router.navigate({ to: '/agents' });
    });
    await heading('Agents');
    await waitFor(() => expect(headers.length).toBeGreaterThan(0));
    expect(headers.every((h) => h === ids.plat)).toBe(true);
  });

  it('disables the action with a reason for a principal that may act only in its own tenant', async () => {
    asTenantAdminBelow();
    // another reachable-looking node must still be refused client side
    const { user } = await renderApp('/tenants');
    await grid();
    // own node is the current tenant: no action
    expect(within(rowOf('Security')).getByText('Current tenant')).toBeInTheDocument();
    // a path stub is focusable-disabled with its reason
    const stub = within(rowOf('Example Org'));
    const button = stub.getByRole('button', { name: 'Switch to Example Org' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(
      'Parent of your tenant: only its name is shown, you cannot open it.',
    );
    await user.click(button);
    expect(activeTenant.get()).toBeNull();
    rowOf('EU').focus();
    await user.keyboard('{Enter}');
    expect(activeTenant.get()).toBeNull();
    expect(
      screen.getByText('Parent of your tenant: only its name is shown, you cannot open it.', {
        selector: 'p',
      }),
    ).toBeInTheDocument();
  });

  it('refuses a switch for a visible node outside the own tenant with the reason', async () => {
    // a non-operator who somehow sees a second node (defensive: the API would answer 404)
    const items = [f.stubbedTree[2]!, { ...f.platformTree[3]!, parentId: null, depth: 2 }];
    asTenantAdminBelow();
    server.use(
      http.get(api('/v1/tenants/tree'), () => HttpResponse.json({ items, truncated: false })),
    );
    const { user } = await renderApp('/tenants');
    await grid();
    const button = within(rowOf('Product')).getByRole('button', { name: 'Switch to Product' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('You can act only in your own tenant.');
    await user.click(button);
    expect(activeTenant.get()).toBeNull();
  });
});

describe('search and URL state', () => {
  it('filters the tree after a debounce, expands the path to a match and writes ?q', async () => {
    asPlatformAdmin();
    const { user, router } = await renderApp('/tenants');
    await grid();
    await user.type(
      screen.getByRole('searchbox', { name: 'Search tenants by name or slug' }),
      'prod',
    );
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'prod' }));
    // match plus ancestors, siblings gone
    expect(rowNames()).toEqual(['Example Org', 'Security', 'Product']);
    expect(rowOf('Security')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('1 tenant matches')).toBeInTheDocument();
    // clearing restores the stored expand state and removes the parameter
    await user.clear(screen.getByRole('searchbox'));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(rowNames()).toEqual(['Example Org', 'Platform', 'Security']);
  });

  it('starts from ?q and reports no match', async () => {
    asPlatformAdmin();
    const { router } = await renderApp('/tenants?q=sec');
    await grid();
    expect(screen.getByRole('searchbox')).toHaveValue('sec');
    expect(rowNames()).toEqual(['Example Org', 'Security']);
    await act(async () => {
      await router.navigate({ to: '/tenants', search: { q: 'zzz' } });
    });
    expect(await screen.findByText('No tenant matches "zzz".')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('zzz');
  });
});

describe('phone layout', () => {
  it('renders cards with depth indicators and no grid', async () => {
    const restore = phone(true);
    try {
      asPlatformAdmin();
      const { user } = await renderApp('/tenants');
      const list = await screen.findByRole('list', { name: 'Tenant tree' }, { timeout: 5000 });
      expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
      const cards = within(list).getAllByRole('listitem');
      expect(cards).toHaveLength(3);
      expect(within(cards[0]!).getByText('Level 1')).toBeInTheDocument();
      expect(within(cards[2]!).getByText('Level 2')).toBeInTheDocument();
      expect(cards[2]).toHaveAttribute('data-level', '2');
      // expandable via a real button
      await user.click(screen.getByRole('button', { name: 'Expand Security' }));
      expect(within(list).getAllByRole('listitem')).toHaveLength(4);
      // switch from a card
      await user.click(
        within(within(list).getAllByRole('listitem')[1]!).getByRole('button', {
          name: /^Switch to /,
        }),
      );
      await waitFor(() => expect(activeTenant.get()).not.toBeNull());
      await expectNoA11yViolations();
    } finally {
      restore();
    }
  });

  it('shows the disabled reason as text on a card', async () => {
    const restore = phone(true);
    try {
      asTenantAdminBelow();
      await renderApp('/tenants');
      const list = await screen.findByRole('list', { name: 'Tenant tree' }, { timeout: 5000 });
      const reasons = within(list).getAllByText(
        'Parent of your tenant: only its name is shown, you cannot open it.',
        { selector: 'span.tenant-reason' },
      );
      expect(reasons).toHaveLength(2); // the two path stubs
      expect(reasons[0]).toBeVisible();
    } finally {
      restore();
    }
  });
});

describe('accessibility and language', () => {
  it('has no axe violations (grid, expanded and searched)', async () => {
    asPlatformAdmin();
    const { user } = await renderApp('/tenants');
    await grid();
    await expectNoA11yViolations();
    await user.click(screen.getByRole('button', { name: 'Expand Security' }));
    await expectNoA11yViolations();
    await user.type(screen.getByRole('searchbox'), 'sec');
    await screen.findByText('1 tenant matches');
    await expectNoA11yViolations();
  });

  it('has no axe violations for the stub tree and the truncated banner', async () => {
    asTenantAdminBelow();
    await renderApp('/tenants');
    await grid();
    await expectNoA11yViolations();
  });

  it('is translated to German', async () => {
    asPlatformAdmin();
    await renderApp('/tenants', { locale: 'de' });
    expect(
      await screen.findByRole('treegrid', { name: 'Tenant-Baum' }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Kosten / Limit' })).toBeInTheDocument();
    expect(screen.getAllByText('(geerbt)').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Tenants' }).length).toBeGreaterThan(0);
  });
});
