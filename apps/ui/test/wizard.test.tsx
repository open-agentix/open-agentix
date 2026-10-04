import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  generateAgentsMd,
  slugify,
  toolGrants,
  triggerYaml,
  type WizardAnswers,
} from '../src/features/wizard/generate';
import { advertisedTools, publisherRoles } from '../src/features/wizard/WizardPage';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

const base: WizardAnswers = {
  title: 'CVE Triage für Images',
  description: 'Rate CVEs',
  owner: 'Team Security',
  classification: 'internal',
  trigger: { kind: 'webhook', value: 'Trivy' },
  steps: [
    { text: 'Look up the CVE', server: 'cve-db', tool: 'lookup_cve', approval: false },
    { text: 'Comment on the ticket', server: 'tickets', tool: 'add_comment', approval: true },
    { text: 'Look up again', server: 'cve-db', tool: 'lookup_cve', approval: true },
    { text: '  ', server: '', tool: '', approval: false },
  ],
  output: { format: 'ticket-update', target: 'tickets/add_comment' },
  provider: 'simulated',
  model: 'sim-1',
  maxCostUsd: 0.3,
};

describe('wizard generator', () => {
  it('creates a slugged, readable agents.md', () => {
    const md = generateAgentsMd(base);
    expect(md).toContain('name: cve-triage-fur-images');
    expect(md).toContain('owner: team-security');
    expect(md).toContain('  - type: webhook\n    source: trivy');
    expect(md).toContain('approval: required');
    expect(md).toContain('maxCostUsd: 0.3');
    expect(md).toContain('target: "tickets/add_comment"');
    expect(md).toContain('simulation:');
    expect(md).toContain(
      '2. Comment on the ticket (tool `tickets/add_comment`, needs human approval)',
    );
    expect(md).toContain('Finally, reply as **ticket-update** to `tickets/add_comment`.');
    expect(md).not.toContain('4.');
  });

  it('covers triggers, defaults and slugs', () => {
    expect(triggerYaml({ kind: 'kafka', value: '' })).toContain('topic: "events"');
    expect(triggerYaml({ kind: 'cron', value: '' })).toContain('0 9 * * 1-5');
    expect(triggerYaml({ kind: 'manual', value: '' })).toBe('  - type: manual');
    expect(triggerYaml({ kind: 'mail', value: 'Support Inbox' })).toContain(
      'source: support-inbox',
    );
    expect(slugify('123 !!!')).toBe('my-agent');
    expect(slugify('Ärger & Co.')).toBe('arger-co');
    expect(toolGrants(base.steps)).toEqual([
      { server: 'cve-db', tool: 'lookup_cve', approval: true },
      { server: 'tickets', tool: 'add_comment', approval: true },
    ]);
    const minimal = generateAgentsMd({
      ...base,
      title: '',
      description: '',
      steps: [],
      provider: 'bedrock',
      model: '',
      maxCostUsd: 0,
      output: { format: 'json', target: '' },
    });
    expect(minimal).toContain('tools: []');
    expect(minimal).toContain('maxCostUsd: 0.5');
    expect(minimal).toContain('1. Describe what the agent should do.');
    expect(minimal).not.toContain('simulation:');
  });

  it('knows tools and publishers', () => {
    expect(advertisedTools(f.connections[0])).toEqual(['get_ticket', 'update_ticket']);
    expect(
      advertisedTools({ ...f.connections[0]!, config: { allowedTools: [{ name: 'a' }, 3] } }),
    ).toEqual(['a']);
    expect(advertisedTools(undefined)).toEqual([]);
    expect(publisherRoles()).toEqual(['admin', 'agent-engineer']);
  });
});

describe('wizard page', () => {
  it('walks a business user through the dialog and creates a draft', async () => {
    let created = '';
    server.use(
      http.post(api('/v1/agents'), async ({ request }) => {
        created = ((await request.json()) as { source: string }).source;
        return HttpResponse.json({ ...f.draftOnlyAgent, draftSource: created }, { status: 201 });
      }),
    );
    const { user, router } = await renderApp('/wizard');
    await heading('Workflow wizard');
    expect(screen.getByRole('heading', { name: 'When … happens' })).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.selectOptions(await screen.findByLabelText('Which source?'), 'jira');
    await expectNoA11yViolations();
    await user.click(next);

    expect(await screen.findByRole('heading', { name: '… check / do …' })).toHaveFocus();
    await user.type(screen.getByLabelText('Step 1'), 'Read the ticket');
    await user.selectOptions(screen.getByLabelText('Uses the tool of'), 'tickets');
    await user.selectOptions(screen.getByLabelText('Tool'), 'update_ticket');
    await user.click(screen.getByLabelText(/a human must approve/i));
    await user.click(screen.getByRole('button', { name: 'Add a step' }));
    await user.type(screen.getByLabelText('Step 2'), 'Remove me');
    await user.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(screen.queryByLabelText('Step 2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('heading', { name: '… then reply as …' })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/ticket update/i));
    await user.type(screen.getByLabelText(/where should it go/i), 'tickets/add_comment');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await screen.findByRole('heading', { name: 'Name it and hand it over' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft for review' })).toBeDisabled();
    await user.type(screen.getByLabelText(/name of the workflow/i), 'Ticket triage');
    await user.selectOptions(screen.getByLabelText('Owner team'), 'team-security');
    expect(screen.getByText(/roles: admin, agent-engineer/)).toBeInTheDocument();
    expect(screen.getByText(/wait for a human at run time/)).toBeInTheDocument();
    await user.click(screen.getByText('Show generated agents.md'));
    expect(await screen.findByText('Valid', {}, { timeout: 3000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: '… then reply as …' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create draft for review' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${f.ids.agent2}`));
    expect(created).toContain('name: ticket-triage');
    expect(created).toContain('source: jira');
    expect(created).toContain('tool: "update_ticket"');
    expect(created).toContain('approval: required');
  });

  it('supports schedules, free-text sources and Kafka', async () => {
    server.use(http.get(api('/v1/event-sources'), () => HttpResponse.json({ items: [] })));
    const { user } = await renderApp('/wizard');
    await heading('Workflow wizard');
    await user.type(await screen.findByLabelText('Name of the source'), 'github');
    await user.click(screen.getByLabelText(/a message on a stream/i));
    await user.type(screen.getByLabelText('Kafka topic'), 'scans');
    await user.click(screen.getByLabelText(/on a schedule/i));
    expect(screen.getByLabelText('Every day at 09:00')).toBeChecked();
    await user.click(screen.getByLabelText('Weekdays at 08:00'));
    expect(screen.getByLabelText('Schedule (cron)')).toHaveValue('0 8 * * 1-5');
    await user.clear(screen.getByLabelText('Schedule (cron)'));
    await user.type(screen.getByLabelText('Schedule (cron)'), '*/5 * * * *');
    await user.click(screen.getByLabelText(/someone starts it/i));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('lets users without write permission copy the result', async () => {
    asViewer();
    server.use(
      http.get(api('/v1/connections'), () =>
        HttpResponse.json({ items: [{ ...f.connections[0]!, config: {} }] }),
      ),
    );
    const { user } = await renderApp('/wizard');
    await heading('Workflow wizard');
    await user.click(screen.getByLabelText(/someone starts it/i));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByLabelText('Step 1'), 'Summarise');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const review = await screen.findByRole('heading', { name: 'Name it and hand it over' });
    const section = review.closest('section')!;
    await user.type(within(section).getByLabelText('Owner team'), 'ops');
    expect(
      within(section).getByRole('button', { name: /copy agents.md for your agent engineer/i }),
    ).toBeInTheDocument();
  });
});
