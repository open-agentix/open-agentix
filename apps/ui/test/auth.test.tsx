import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../src/features/auth/LoginPage';
import { readTokenFromHash } from '../src/features/auth/OidcCallback';
import { session } from '../src/auth/session';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('login', () => {
  it('redirects to the login page without a session and is accessible', async () => {
    const { router } = await renderApp('/agents', { signedIn: false });
    await heading('Sign in');
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByRole('link', { name: /single sign-on/i })).toHaveAttribute(
      'href',
      `${window.location.origin}/v1/auth/oidc/login`,
    );
    expect(screen.getByText(/built by agentix-zero/i)).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('sends signed-out visitors on an unknown path to the login page', async () => {
    const { router } = await renderApp('/does/not/exist', { signedIn: false });
    await heading('Sign in');
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({});
    expect(screen.queryByText(/page not found/i)).not.toBeInTheDocument();
  });

  it('still shows the not-found page to signed-in users', async () => {
    const { router } = await renderApp('/does/not/exist');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/does/not/exist');
    expect(screen.getByRole('link', { name: /back to the dashboard/i })).toBeInTheDocument();
  });

  it('validates empty input and shows a wrong-password message', async () => {
    server.use(
      http.post(api('/v1/auth/login'), () =>
        HttpResponse.json({ error: 'unauthenticated', message: 'bad' }, { status: 401 }),
      ),
    );
    const { user } = await renderApp('/login', { signedIn: false });
    await heading('Sign in');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/enter username and password/i);
    await user.type(screen.getByLabelText(/username/i), 'ada');
    await user.type(screen.getByLabelText(/^password/i), 'wrong');
    await user.click(screen.getByLabelText('Directory (LDAP)'));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/username or password is wrong/i)).toBeInTheDocument();
  });

  it('shows a generic error when the server fails', async () => {
    server.use(
      http.post(api('/v1/auth/login'), () =>
        HttpResponse.json({ error: 'x', message: 'boom' }, { status: 500 }),
      ),
    );
    const { user } = await renderApp('/login', { signedIn: false });
    await heading('Sign in');
    await user.type(screen.getByLabelText(/username/i), 'ada');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/sign-in failed/i)).toBeInTheDocument();
  });

  it('signs in with local credentials and follows the redirect', async () => {
    let body: unknown;
    server.use(
      http.post(api('/v1/auth/login'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          token: 'oax_new_token_123',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: f.adminUser,
        });
      }),
    );
    const { user, router } = await renderApp('/login?redirect=%2Fsettings', { signedIn: false });
    await heading('Sign in');
    await user.click(screen.getByLabelText('Local account'));
    await user.type(screen.getByLabelText(/username/i), ' ada ');
    await user.type(screen.getByLabelText(/^password/i), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await heading('Settings');
    expect(router.state.location.pathname).toBe('/settings');
    expect(body).toEqual({ username: 'ada', password: 'secret-password', method: 'local' });
    expect(session.token()).toBe('oax_new_token_123');
  });

  it('tells the user when the session expired', async () => {
    await renderApp('/login?expired=true', { signedIn: false });
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
  });

  it('only accepts same-origin redirects', () => {
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect('https://evil.example/x')).toBe('/');
    expect(safeRedirect('//evil.example/x')).toBe('/');
    expect(safeRedirect('/login?x=1')).toBe('/');
    expect(safeRedirect('/runs?status=failed#top')).toBe('/runs?status=failed#top');
    expect(safeRedirect('http://[invalid')).toBe('/');
  });
});

describe('OIDC callback', () => {
  it('reads the token from the fragment', () => {
    expect(readTokenFromHash('#token=oax_abcdefghijk')).toBe('oax_abcdefghijk');
    expect(readTokenFromHash('#token=short')).toBeNull();
    expect(readTokenFromHash('')).toBeNull();
  });

  it('stores the session and opens the dashboard', async () => {
    window.history.replaceState(null, '', '/auth/callback#token=oax_from_oidc_123');
    const { router } = await renderApp('/auth/callback', { signedIn: false });
    await heading(/hello ada admin/i);
    expect(router.state.location.pathname).toBe('/');
    expect(session.token()).toBe('oax_from_oidc_123');
    expect(window.location.hash).toBe('');
  });

  it('shows an error without token', async () => {
    window.history.replaceState(null, '', '/auth/callback');
    await renderApp('/auth/callback', { signedIn: false });
    expect(await screen.findByText(/did not return a session/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign-in/i })).toBeInTheDocument();
  });
});

describe('session expiry', () => {
  it('sends the user to the login page when the API answers 401', async () => {
    server.use(
      http.get(api('/v1/me'), () =>
        HttpResponse.json({ error: 'unauthenticated', message: 'expired' }, { status: 401 }),
      ),
    );
    const { router } = await renderApp('/agents');
    await heading('Sign in');
    expect(router.state.location.search).toMatchObject({ expired: true });
  });

  it('logs out', async () => {
    const { user, router } = await renderApp('/');
    await heading(/hello/i);
    const nav = screen.getByRole('complementary');
    await user.click(within(nav).getByRole('button', { name: 'Sign out' }));
    await heading('Sign in');
    expect(router.state.location.pathname).toBe('/login');
    expect(session.token()).toBeNull();
  });

  it('reacts to an expired token while the app is open', async () => {
    const { router } = await renderApp('/');
    await heading(/hello/i);
    session.expire();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});
