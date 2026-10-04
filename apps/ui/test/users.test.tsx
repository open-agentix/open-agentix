import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('users, teams and roles', () => {
  it('lists users and edits roles', async () => {
    let patch: unknown;
    server.use(
      http.patch(api('/v1/users/:id'), async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json({ ...f.adminUser, displayName: 'Ada A.' });
      }),
    );
    const { user } = await renderApp('/users');
    await heading('Users & teams');
    expect(await screen.findByText('ada@example.org · local')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(await screen.findByText('Security (agent-engineer)')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.click(screen.getByRole('button', { name: 'Edit Ada Admin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Ada Admin' });
    await user.clear(within(dialog).getByLabelText(/^name/i));
    await user.type(within(dialog).getByLabelText(/^name/i), 'Ada A.');
    await user.click(within(dialog).getByLabelText(/^operator/));
    await user.click(within(dialog).getByLabelText(/^admin/));
    await user.click(within(dialog).getByLabelText('Disable this account'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Ada A. saved.')).toBeInTheDocument();
    expect(patch).toEqual({ displayName: 'Ada A.', globalRoles: ['operator'], disabled: true });
  });

  it('creates a local user with validation', async () => {
    const { user } = await renderApp('/users');
    await heading('Users & teams');
    await user.click(await screen.findByRole('button', { name: 'New local user' }));
    const dialog = await screen.findByRole('dialog', { name: 'New local user' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await user.type(within(dialog).getByLabelText(/e-mail/i), 'bob@example.org');
    await user.type(within(dialog).getByLabelText(/^name/i), 'Bob');
    await user.type(within(dialog).getByLabelText(/initial password/i), 'short');
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/initial password/i), '-but-longer');
    server.use(
      http.post(api('/v1/users'), () =>
        HttpResponse.json({ error: 'conflict', message: 'email exists' }, { status: 409 }),
      ),
    );
    await user.click(save);
    expect(await within(dialog).findByText('email exists')).toBeInTheDocument();
  });

  it('creates teams and manages members', async () => {
    let members: unknown;
    server.use(
      http.put(api('/v1/teams/:id/members'), async ({ request }) => {
        members = await request.json();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const { user } = await renderApp('/users?tab=teams');
    expect(await screen.findByText('budget $10.00/month')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New team' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByLabelText(/team name/i), 'Platform');
    await user.type(within(dialog).getByLabelText(/^slug/i), 'Platform');
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/^slug/i));
    await user.type(within(dialog).getByLabelText(/^slug/i), 'platform');
    await user.type(within(dialog).getByLabelText(/monthly budget/i), '50');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Team Platform created.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Members' }));
    const mdialog = await screen.findByRole('dialog', { name: 'Members of Security' });
    expect(within(mdialog).getByLabelText(/Ada Admin/)).toHaveValue('agent-engineer');
    await user.selectOptions(within(mdialog).getByLabelText(/Vic Viewer/), 'operator');
    await user.click(within(mdialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(members).toEqual({
        members: [
          { userId: f.ids.admin, role: 'agent-engineer' },
          { userId: f.ids.viewer, role: 'operator' },
        ],
      }),
    );
  });

  it('shows the role-permission matrix', async () => {
    const { user } = await renderApp('/users');
    await heading('Users & teams');
    await user.click(screen.getByRole('tab', { name: 'Role matrix' }));
    const table = await screen.findByRole('table', { name: 'Role-permission matrix' });
    const row = within(table).getByRole('row', { name: /audit:verify/ });
    expect(within(row).getAllByRole('img', { name: 'granted' })).toHaveLength(2);
    await expectNoA11yViolations();
  });

  it('shows empty and error states', async () => {
    server.use(
      http.get(api('/v1/users'), () =>
        HttpResponse.json({ error: 'x', message: 'ldap down' }, { status: 500 }),
      ),
      http.get(api('/v1/teams'), () => HttpResponse.json({ items: [] })),
    );
    const { user } = await renderApp('/users');
    expect(await screen.findByText('ldap down')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Teams' }));
    expect(await screen.findByText('No teams yet')).toBeInTheDocument();
  });
});
