import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { groupScopes, isExpired, SCOPES } from '../src/features/tokens/TokensPage';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('API tokens', () => {
  it('lists tokens and creates one that is shown once', async () => {
    let body: unknown;
    server.use(
      http.post(api('/v1/tokens'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { ...f.tokens[0]!, name: 'ci', token: 'oax_secret_token_value_123' },
          { status: 201 },
        );
      }),
    );
    const { user } = await renderApp('/tokens');
    await heading('API tokens');
    expect(await screen.findByText('ci-deploy')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('all permissions of the owner')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.click(screen.getByRole('button', { name: 'New token' }));
    const dialog = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(dialog).getByLabelText(/^name/i), 'ci');
    await user.click(within(dialog).getByRole('checkbox', { name: 'read', checked: true }));
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    const runs = within(dialog).getByText('runs').closest('div')!;
    await user.click(within(runs).getByLabelText('execute'));
    await user.clear(within(dialog).getByLabelText(/valid for/i));
    await user.type(within(dialog).getByLabelText(/valid for/i), '7');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const created = await screen.findByRole('dialog', { name: 'Token created' });
    expect(within(created).getByText('oax_secret_token_value_123')).toBeInTheDocument();
    expect(body).toEqual({ name: 'ci', scopes: ['runs:execute'], expiresInDays: 7 });
    await user.click(within(created).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('oax_secret_token_value_123')).not.toBeInTheDocument();
  });

  it('revokes a token after confirmation and can show all tokens', async () => {
    const queries: string[] = [];
    server.use(
      http.get(api('/v1/tokens'), ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ items: f.tokens });
      }),
    );
    const { user } = await renderApp('/tokens');
    await user.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Revoke ci-deploy?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Token ci-deploy revoked.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Show tokens of all users'));
    await waitFor(() => expect(queries).toContain('?all=true'));
  });

  it('shows creation errors and the empty state', async () => {
    server.use(
      http.get(api('/v1/tokens'), () => HttpResponse.json({ items: [] })),
      http.post(api('/v1/tokens'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'scope exceeds owner' }, { status: 403 }),
      ),
    );
    const { user } = await renderApp('/tokens');
    expect(await screen.findByText('No API tokens')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New token' }));
    const dialog = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(dialog).getByLabelText(/^name/i), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('scope exceeds owner')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('groups scopes and detects expiry', () => {
    expect(groupScopes(SCOPES).map(([r]) => r)).toEqual([
      'agents',
      'runs',
      'events',
      'sources',
      'connections',
      'policies',
      'audit',
      'costs',
      'users',
      'tokens',
      'settings',
    ]);
    expect(isExpired(f.tokens[1]!)).toBe(true);
    expect(isExpired(f.tokens[0]!)).toBe(false);
  });
});
