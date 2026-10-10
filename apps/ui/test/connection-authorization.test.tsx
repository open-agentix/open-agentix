import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateTo } from '../src/lib/navigate';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

vi.mock('../src/lib/navigate', () => ({ navigateTo: vi.fn() }));

const AUTH_URL = 'https://auth.example.org/authorize?response_type=code&state=abc';
const oauthConnection = (grant = 'authorization_code') => ({
  ...f.connections[0]!,
  name: 'issues',
  config: {
    transport: 'streamable-http',
    url: 'https://mcp.example.org/mcp',
    auth: { kind: 'oauth', grant, client: { registration: 'dcr' } },
  },
});
const status = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  grant: 'authorization_code',
  issuer: 'https://auth.example.org',
  pinnedIssuer: null,
  scopes: ['issues.read'],
  expiresAt: null,
  authorizedAt: new Date('2026-10-10T12:00:00Z').toISOString(),
  authorizedBy: 'user-1',
  lastError: null,
  endpointHosts: ['auth.example.org'],
  scopesWider: false,
  registration: 'dcr',
  redirectUri: 'https://oax.example.org/v1/oauth/mcp/callback',
  scopesMissing: [],
  requiredScopes: [],
  reauthorizationNeeded: false,
  pendingExpiresAt: null,
  ...over,
});

function stub(st: Record<string, unknown> = status(), connection = oauthConnection()) {
  const posts: { url: string; body: unknown }[] = [];
  server.use(
    http.get(api('/v1/connections'), () => HttpResponse.json({ items: [connection] })),
    http.get(api('/v1/connections/:id/oauth'), () => HttpResponse.json(st)),
    http.post(api('/v1/connections/:id/oauth/authorize'), async ({ request }) => {
      posts.push({ url: 'authorize', body: await request.json() });
      return HttpResponse.json({ ...st, authorizationUrl: AUTH_URL });
    }),
    http.post(api('/v1/connections/:id/oauth/disconnect'), () => {
      posts.push({ url: 'disconnect', body: null });
      return HttpResponse.json(
        status({ status: 'not_authorized', scopes: [], authorizedAt: null }),
      );
    }),
  );
  return posts;
}

beforeEach(() => {
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState({}, '', '/');
});

describe('Authorization of an OAuth connection', () => {
  it('is offered for OAuth connections only', async () => {
    await renderApp('/connections');
    await heading('Connections');
    expect(screen.queryByRole('button', { name: 'Authorization' })).not.toBeInTheDocument();
  });

  it('shows the state, who authorized and when, the scopes and the redirect URI', async () => {
    stub();
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    expect(await within(dialog).findByText('Authorized')).toBeInTheDocument();
    expect(within(dialog).getByText('Authorization code with PKCE')).toBeInTheDocument();
    expect(within(dialog).getByText('Dynamic registration')).toBeInTheDocument();
    expect(within(dialog).getByText('https://auth.example.org')).toBeInTheDocument();
    expect(within(dialog).getByText('issues.read')).toBeInTheDocument();
    expect(within(dialog).getByText(/user-1,/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('https://oax.example.org/v1/oauth/mcp/callback'),
    ).toBeInTheDocument();
    // the tokens are never part of the view
    expect(dialog.textContent).not.toMatch(/token_|Bearer|oaxe1/);
    await expectNoA11yViolations(dialog);
  });

  it('opens the consent at the authorization server', async () => {
    const posts = stub(status({ status: 'not_authorized', scopes: [], authorizedAt: null }));
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    await user.click(await within(dialog).findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(AUTH_URL));
    expect(posts).toEqual([{ url: 'authorize', body: {} }]);
  });

  it('says what a step-up needs and asks to authorize again', async () => {
    stub(
      status({
        status: 'reauthorization_required',
        reauthorizationNeeded: true,
        requiredScopes: ['issues.write'],
        lastError: 'insufficient_scope',
      }),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server asked for more scopes (issues.write)',
    );
    expect(within(dialog).getByText('Authorization needed again')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Authorize again' })).toBeInTheDocument();
  });

  it('lets the administrator choose when the resource names several authorization servers', async () => {
    const posts = stub(status({ status: 'not_authorized', scopes: [] }));
    server.use(
      http.post(api('/v1/connections/:id/oauth/authorize'), async ({ request }) => {
        const body = (await request.json()) as { issuer?: string };
        posts.push({ url: 'authorize', body });
        if (!body.issuer)
          return HttpResponse.json(
            {
              error: 'mcp_oauth_issuer_required',
              message: 'choose one',
              details: { issuers: ['https://a.example.org', 'https://b.example.org'] },
            },
            { status: 409 },
          );
        return HttpResponse.json({ ...status(), authorizationUrl: AUTH_URL });
      }),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    await user.click(await within(dialog).findByRole('button', { name: 'Connect' }));
    await user.selectOptions(
      await within(dialog).findByLabelText('Authorization server'),
      'https://b.example.org',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(AUTH_URL));
    expect(posts.at(-1)!.body).toEqual({ issuer: 'https://b.example.org' });
  });

  it('disconnects after a confirmation', async () => {
    const posts = stub();
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    await user.click(await within(dialog).findByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disconnect issues?' });
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(posts).toEqual([{ url: 'disconnect', body: null }]));
  });

  it('a viewer sees the state but no way to change it', async () => {
    asViewer();
    stub();
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Authorization of issues' });
    expect(await within(dialog).findByText('Authorized')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('reports the result of the callback, opens the view and removes the parameters from the URL', async () => {
    stub();
    window.history.replaceState(
      {},
      '',
      `/connections?mcp_oauth=iss_mismatch&connection=${f.connections[0]!.id}`,
    );
    await renderApp('/connections');
    expect(
      await screen.findByText(/came from another authorization server than the request/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Authorization of issues' })).toBeVisible();
    expect(window.location.search).toBe('');
  });

  it('shows an unknown callback result as a plain failure, never as the text of the URL', async () => {
    stub();
    window.history.replaceState({}, '', '/connections?mcp_oauth=%3Cscript%3E');
    await renderApp('/connections');
    expect(await screen.findByText('The authorization failed.')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('<script>');
  });

  it('is available in German', async () => {
    stub();
    const { user } = await renderApp('/connections', { locale: 'de' });
    await user.click(await screen.findByRole('button', { name: 'Autorisierung' }));
    expect(
      await screen.findByRole('dialog', { name: 'Autorisierung von issues' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Autorisiert')).toBeInTheDocument();
  });
});
