import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MAX_PLAN_BYTES } from '../src/features/plans/PlansPage';
import { takeAgentDraft } from '../src/features/plans/draft';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

describe('plans page', () => {
  it('checks a plan, shows findings and keeps the page accessible', async () => {
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    const check = screen.getByRole('button', { name: 'Check plan' });
    expect(check).toBeDisabled();
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'name: x ERRORS');
    await user.click(check);
    const table = await screen.findByRole('region', { name: 'Findings (table)' });
    expect(within(table).getByText('LP006')).toBeInTheDocument();
    expect(within(table).getByText('steps.0.capabilities.0')).toBeInTheDocument();
    expect(within(table).getByText('Looks reasonable.')).toBeInTheDocument();
    expect(within(table).getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('1 errors, 0 warnings, 1 notes')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('says so when there are no findings', async () => {
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'name: x');
    await user.click(screen.getByRole('button', { name: 'Check plan' }));
    expect(await screen.findByText(/No findings/)).toBeInTheDocument();
  });

  it('lists parse errors for an invalid plan', async () => {
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'INVALID');
    await user.click(screen.getByRole('button', { name: 'Check plan' }));
    expect(
      await screen.findByRole('heading', { name: 'The plan is not valid' }),
    ).toBeInTheDocument();
    expect(screen.getByText('steps.0.access')).toBeInTheDocument();
  });

  it('generates a draft and hands it to the new agent editor (nothing is saved here)', async () => {
    let created = false;
    server.use(
      http.post(
        api('/v1/agents'),
        () => ((created = true), HttpResponse.json({}, { status: 500 })),
      ),
    );
    const { user, router } = await renderApp('/plans');
    await heading('Agent plans');
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'name: x');
    await user.click(screen.getByRole('button', { name: 'Generate agents.md draft' }));
    const draft = await screen.findByLabelText('Generated text');
    expect(draft).toHaveTextContent('name: demo-plan');
    expect(screen.getByText(/A draft only/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in the new agent editor' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/new'));
    expect(await screen.findByDisplayValue(/name: demo-plan/)).toBeInTheDocument();
    expect(created).toBe(false);
    expect(takeAgentDraft()).toBeNull();
  });

  it('withholds the draft when the plan has errors', async () => {
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'ERRORS');
    await user.click(screen.getByRole('button', { name: 'Generate agents.md draft' }));
    expect(await screen.findByText('No draft was generated')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open in the new agent editor' }),
    ).not.toBeInTheDocument();
  });

  it('reads an uploaded file and refuses files over the limit', async () => {
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    const input = screen.getByLabelText('Upload a file', { selector: 'input' });
    await user.upload(input, new File(['name: from-file'], 'plan.yaml', { type: 'text/yaml' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Agent plan (YAML or JSON)')).toHaveValue('name: from-file'),
    );
    const big = new File(['x'], 'big.yaml');
    Object.defineProperty(big, 'size', { value: MAX_PLAN_BYTES + 1 });
    await user.upload(input, big);
    expect(await screen.findByText('The file is larger than 64 KiB.')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent plan (YAML or JSON)')).toHaveValue('name: from-file');
  });

  it('shows API errors', async () => {
    server.use(
      http.post(api('/v1/plans/check'), () =>
        HttpResponse.json({ error: 'rate_limited', message: 'too many requests' }, { status: 429 }),
      ),
    );
    const { user } = await renderApp('/plans');
    await heading('Agent plans');
    await user.type(screen.getByLabelText('Agent plan (YAML or JSON)'), 'name: x');
    await user.click(screen.getByRole('button', { name: 'Check plan' }));
    expect(await screen.findByText('too many requests')).toBeInTheDocument();
  });

  it('read-only users can check but not generate drafts', async () => {
    asViewer();
    await renderApp('/plans');
    await heading('Agent plans');
    expect(screen.getByRole('button', { name: 'Check plan' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Generate agents.md draft' }),
    ).not.toBeInTheDocument();
  });

  it('is available in German', async () => {
    await renderApp('/plans', { locale: 'de' });
    await heading('Agent-Pläne');
    expect(screen.getByRole('button', { name: 'Plan prüfen' })).toBeInTheDocument();
  });
});
