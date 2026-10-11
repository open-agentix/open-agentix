import { createHash } from 'node:crypto';
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
  window.sessionStorage.clear();
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
    // only the hash of the nonce is sent; the nonce stays in this tab's session storage
    const body = posts[0]!.body as { nonceHash: string };
    expect(Object.keys(body)).toEqual(['nonceHash']);
    expect(body.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    const kept = JSON.parse(window.sessionStorage.getItem('oax.mcp.consent') ?? 'null') as {
      connectionId: string;
      nonce: string;
    };
    expect(kept.connectionId).toBe(f.connections[0]!.id);
    expect(kept.nonce).not.toBe(body.nonceHash);
    expect(createHash('sha256').update(kept.nonce).digest('hex')).toBe(body.nonceHash);
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
              details: {
                issuers: ['https://a.example.org', 'https://b.example.org'],
                scopes: ['issues.read', 'offline_access'],
              },
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
    // nothing leaves the console before the administrator has seen the server and the scopes
    expect(navigateTo).not.toHaveBeenCalled();
    expect(await within(dialog).findByText('offline_access')).toBeInTheDocument();
    await user.selectOptions(
      await within(dialog).findByLabelText('Authorization server'),
      'https://b.example.org',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith(AUTH_URL));
    expect(posts.at(-1)!.body).toMatchObject({ issuer: 'https://b.example.org' });
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

  it('completes the consent in the tab that started it, clears the fragment and opens the view', async () => {
    stub();
    const completes: unknown[] = [];
    server.use(
      http.post(api('/v1/connections/:id/oauth/complete'), async ({ request }) => {
        completes.push(await request.json());
        return HttpResponse.json({ result: 'iss_mismatch', status: null });
      }),
    );
    window.sessionStorage.setItem(
      'oax.mcp.consent',
      JSON.stringify({ connectionId: f.connections[0]!.id, nonce: 'the-nonce-of-this-tab' }),
    );
    window.history.replaceState({}, '', '/connections#oauth_state=S&oauth_code=C&oauth_iss=I');
    await renderApp('/connections');
    expect(
      await screen.findByText(/came from another authorization server than the request/),
    ).toBeInTheDocument();
    expect(completes).toEqual([
      { state: 'S', code: 'C', iss: 'I', nonce: 'the-nonce-of-this-tab' },
    ]);
    expect(await screen.findByRole('dialog', { name: 'Authorization of issues' })).toBeVisible();
    // the answer is gone from the address bar and the nonce is spent
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem('oax.mcp.consent')).toBeNull();
  });

  it('a browser that did not start the consent completes nothing and says so', async () => {
    stub();
    const completes: unknown[] = [];
    server.use(
      http.post(api('/v1/connections/:id/oauth/complete'), async ({ request }) => {
        completes.push(await request.json());
        return HttpResponse.json({ result: 'ok', status: null });
      }),
    );
    window.history.replaceState({}, '', '/connections#oauth_state=S&oauth_code=C');
    await renderApp('/connections');
    expect(await screen.findByText(/did not start an authorization/)).toBeInTheDocument();
    expect(completes).toEqual([]);
    expect(window.location.hash).toBe('');
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
