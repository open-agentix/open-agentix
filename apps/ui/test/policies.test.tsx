import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { bundleToForm, formToBundle, invalidPatterns } from '../src/features/policies/bundle';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('policies', () => {
  it('shows rules, budgets and the audit gate explanation', async () => {
    await renderApp('/policies');
    await heading('Policies');
    expect(await screen.findByText('*/delete_*')).toBeInTheDocument();
    expect(screen.getByText('rm\\s+-rf | destructive shell command')).toBeInTheDocument();
    expect(screen.getByText('*/deploy_*')).toBeInTheDocument();
    expect(screen.getByText('Confidential')).toBeInTheDocument();
    expect(screen.getByText('Audit gate (per agent)')).toBeInTheDocument();
    expect(await screen.findByText('$10.00')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('toggles enforcement optimistically', async () => {
    let body: unknown;
    server.use(
      http.put(api('/v1/policies/:id'), async ({ request }) => {
        body = await request.json();
        server.use(
          http.get(api('/v1/policies'), () =>
            HttpResponse.json({ items: [{ ...f.policies[0]!, enabled: false }] }),
          ),
        );
        return HttpResponse.json({ ...f.policies[0]!, enabled: false });
      }),
    );
    const { user } = await renderApp('/policies');
    await user.click(await screen.findByLabelText('Enforce default'));
    await waitFor(() => expect(screen.getByLabelText('Enforce default')).not.toBeChecked());
    expect(body).toEqual({ enabled: false });
  });

  it('rolls back a failed toggle', async () => {
    server.use(
      http.put(api('/v1/policies/:id'), () =>
        HttpResponse.json({ error: 'x', message: 'locked' }, { status: 409 }),
      ),
    );
    const { user } = await renderApp('/policies');
    await user.click(await screen.findByLabelText('Enforce default'));
    expect(await screen.findByText('locked')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Enforce default')).toBeChecked());
  });

  it('creates and edits policies with regex validation', async () => {
    let created: unknown;
    server.use(
      http.post(api('/v1/policies'), async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ ...f.policies[0]!, name: 'strict' }, { status: 201 });
      }),
    );
    const { user } = await renderApp('/policies');
    await heading('Policies');
    await user.click(screen.getByRole('button', { name: 'New policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'New policy' });
    await user.type(within(dialog).getByLabelText(/^name/i), 'strict');
    await user.type(within(dialog).getByLabelText('Forbidden tools'), 'shell/*');
    const args = within(dialog).getByLabelText('Forbidden argument patterns');
    await user.type(args, '([[a-');
    expect(within(dialog).getByText(/invalid regular expression/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(args);
    await user.type(args, 'drop\\s+table | destructive SQL');
    await user.selectOptions(
      within(dialog).getByLabelText('Highest data classification'),
      'internal',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Policy strict saved.')).toBeInTheDocument();
    expect(created).toMatchObject({
      name: 'strict',
      enabled: true,
      bundle: {
        forbiddenTools: ['shell/*'],
        forbiddenArgPatterns: [{ pattern: 'drop\\s+table', reason: 'destructive SQL' }],
        requireApprovalTools: [],
        maxClassification: 'internal',
      },
    });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit default' });
    expect(within(edit).getByLabelText('Forbidden tools')).toHaveValue('*/delete_*\nshell/*');
    server.use(
      http.put(api('/v1/policies/:id'), () =>
        HttpResponse.json({ error: 'x', message: 'invalid bundle' }, { status: 400 }),
      ),
    );
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(await within(edit).findByText('invalid bundle')).toBeInTheDocument();
  });

  it('tries the audit gate without executing anything', async () => {
    let body: unknown;
    server.use(
      http.post(api('/v1/policies/evaluate'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          effect: 'deny',
          reasons: [{ code: 'tool_forbidden', message: 'tickets/delete_ticket is forbidden' }],
        });
      }),
    );
    const { user } = await renderApp('/policies');
    const section = (await screen.findByRole('heading', { name: 'Try the audit gate' })).closest(
      'section',
    )!;
    const run = within(section).getByRole('button', { name: 'Check' });
    expect(run).toBeDisabled();
    await within(section).findByRole('option', { name: 'ticket-updater' });
    await user.selectOptions(within(section).getByLabelText('Agent'), f.ids.agent);
    await user.type(within(section).getByLabelText('Server'), 'tickets');
    await user.type(within(section).getByLabelText('Tool'), 'delete_ticket');
    await user.clear(within(section).getByLabelText('Arguments (JSON)'));
    await user.type(within(section).getByLabelText('Arguments (JSON)'), 'x');
    await user.click(run);
    expect(await within(section).findByRole('alert')).toHaveTextContent(/not valid JSON/);
    await user.clear(within(section).getByLabelText('Arguments (JSON)'));
    await user.type(within(section).getByLabelText('Arguments (JSON)'), '{{"key":"SEC-1"}');
    await user.click(run);
    expect(
      await within(section).findByText('tickets/delete_ticket is forbidden'),
    ).toBeInTheDocument();
    expect(body).toEqual({
      source: f.draftSource,
      agentId: 'main',
      call: { server: 'tickets', tool: 'delete_ticket', args: { key: 'SEC-1' } },
    });
  });

  it('shows the empty state', async () => {
    server.use(http.get(api('/v1/policies'), () => HttpResponse.json({ items: [] })));
    await renderApp('/policies');
    expect(await screen.findByText('No policies yet')).toBeInTheDocument();
  });

  it('converts bundles to forms and back', () => {
    const form = bundleToForm(f.policies[0]!.bundle);
    expect(formToBundle(form)).toEqual(f.policies[0]!.bundle);
    expect(bundleToForm({})).toEqual({
      forbiddenTools: '',
      forbiddenArgPatterns: '',
      requireApprovalTools: '',
      maxClassification: '',
    });
    expect(
      bundleToForm({ forbiddenArgPatterns: [{ pattern: 'x' }, null] }).forbiddenArgPatterns,
    ).toBe('x\nundefined');
    expect(formToBundle({ ...form, forbiddenArgPatterns: 'abc', maxClassification: '' })).toEqual({
      forbiddenTools: ['*/delete_*', 'shell/*'],
      forbiddenArgPatterns: [{ pattern: 'abc' }],
      requireApprovalTools: ['*/deploy_*'],
    });
    expect(invalidPatterns({ ...form, forbiddenArgPatterns: '(a | why\nok' })).toEqual(['(a']);
  });
});
