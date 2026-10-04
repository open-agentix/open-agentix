import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { draftHints, readDefinition } from '../src/features/agents/definition';
import { exampleEvent } from '../src/features/agents/TestRunTab';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

const agentPath = `/agents/${f.ids.agent}`;

describe('agents list', () => {
  it('lists, searches and is accessible', async () => {
    const { user } = await renderApp('/agents');
    await heading('Agents');
    expect(await screen.findByRole('link', { name: 'ticket-updater' })).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Draft only')).toBeInTheDocument();
    expect(await screen.findByText('Security')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.type(screen.getByRole('searchbox', { name: /search agents/i }), 'cve');
    expect(screen.queryByRole('link', { name: 'ticket-updater' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Nothing matches your filters')).toBeInTheDocument();
  });

  it('shows an empty state with the wizard', async () => {
    server.use(
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/agents');
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Describe a workflow' }).length).toBe(2);
  });

  it('hides create actions for viewers', async () => {
    asViewer();
    await renderApp('/agents');
    await heading('Agents');
    expect(screen.queryByRole('link', { name: 'New agent' })).not.toBeInTheDocument();
  });

  it('shows load errors', async () => {
    server.use(
      http.get(api('/v1/agents'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 }),
      ),
    );
    await renderApp('/agents');
    expect(await screen.findByRole('alert')).toHaveTextContent('down');
  });
});

describe('new agent', () => {
  it('creates a draft from the template', async () => {
    const { user, router } = await renderApp('/agents/new');
    await heading('New agent');
    expect(await screen.findByText(/valid · v0.1.0/i, {}, { timeout: 3000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${f.ids.agent2}`));
    expect(await screen.findByText(/created as a draft/i)).toBeInTheDocument();
  });

  it('shows creation errors', async () => {
    server.use(
      http.post(api('/v1/agents'), () =>
        HttpResponse.json({ error: 'conflict', message: 'name taken' }, { status: 409 }),
      ),
    );
    const { user } = await renderApp('/agents/new');
    await heading('New agent');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });

  it('is not available for viewers', async () => {
    asViewer();
    await renderApp('/agents/new');
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
  });
});

describe('agent detail', () => {
  it('shows the overview with runtime, toolbox and tools', async () => {
    await renderApp(agentPath);
    await heading(/ticket-updater/);
    expect(await screen.findByText('git+node')).toBeInTheDocument();
    expect(screen.getByText('jira-cli')).toBeInTheDocument();
    expect(screen.getByText('tickets/update_ticket')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('webhook: jira')).toBeInTheDocument();
    expect(screen.getByText('jira.example.org')).toBeInTheDocument();
    expect(screen.getByText('$0.20')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('shows draft hints when nothing is published', async () => {
    await renderApp(`/agents/${f.ids.agent2}`);
    expect(await screen.findByText('Not published yet')).toBeInTheDocument();
    expect(screen.getByText('jira-cli')).toBeInTheDocument();
    expect(screen.getByText('Global', { exact: false })).toBeInTheDocument();
  });

  it('shows a not-found error', async () => {
    await renderApp('/agents/00000000-0000-4000-8000-000000000000');
    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it('navigates tabs with the keyboard', async () => {
    const { user, router } = await renderApp(agentPath);
    await heading(/ticket-updater/);
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'editor' }));
    expect(screen.getByRole('tab', { name: 'agents.md' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'test' }));
  });

  it('edits with live validation, saves optimistically and publishes with confirmation', async () => {
    let saved = '';
    server.use(
      http.put(api('/v1/agents/:id/draft'), async ({ request }) => {
        saved = ((await request.json()) as { source: string }).source;
        return HttpResponse.json({ ...f.agent, draftSource: saved });
      }),
    );
    const { user } = await renderApp(`${agentPath}?tab=editor`);
    const editor = await screen.findByLabelText('agents.md (draft)');
    await user.click(editor);
    await user.keyboard('{Control>}{End}{/Control}INVALID WARN');
    expect(await screen.findByText('1 error', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('no budget')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();
    await user.keyboard('{Tab}');
    expect((editor as HTMLTextAreaElement).value).toContain('INVALID WARN  ');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect((editor as HTMLTextAreaElement).value).toBe(f.draftSource);
    await user.type(editor, '# more');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(saved).toContain('# more');

    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog', { name: /publish ticket-updater/i });
    expect(await within(dialog).findByText('Will publish v1.1.0')).toBeInTheDocument();
    expect(within(dialog).getByText(/lines added/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Publish version' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/i reviewed the changes/i));
    await user.click(confirm);
    expect(await screen.findByText('Version 1.1.0 published.')).toBeInTheDocument();
  });

  it('rolls back a failed save and reports already-published content', async () => {
    server.use(
      http.put(api('/v1/agents/:id/draft'), () =>
        HttpResponse.json({ error: 'x', message: 'disk full' }, { status: 500 }),
      ),
      http.post(api('/v1/agents/:id/publish'), () =>
        HttpResponse.json({ version: f.versions[1], created: false }),
      ),
    );
    const { user } = await renderApp(`${agentPath}?tab=editor`);
    const editor = await screen.findByLabelText('agents.md (draft)');
    await user.type(editor, 'x');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/saving failed: disk full/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
    expect(await screen.findByText(/already published/i)).toBeInTheDocument();
  });

  it('refuses to publish an invalid draft', async () => {
    server.use(
      http.get(api('/v1/agents/:id'), () =>
        HttpResponse.json({ ...f.agent, draftSource: 'INVALID' }),
      ),
    );
    const { user } = await renderApp(`${agentPath}?tab=editor`);
    await user.click(await screen.findByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('1 error')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/validation errors/i);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    asViewer();
    await renderApp(`${agentPath}?tab=editor`);
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Test run' })).not.toBeInTheDocument();
  });

  it('shows version history and compares versions', async () => {
    const { user, router } = await renderApp(`${agentPath}?tab=versions`);
    const latest = await screen.findByText('Latest');
    expect(latest.closest('li')).toHaveTextContent('v1.0.0');
    await user.click(screen.getByRole('link', { name: 'Compare with v0.9.0' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: 'diff',
        from: '0.9.0',
        to: '1.0.0',
      }),
    );
    expect(await screen.findByText(/v0.9.0 → v1.0.0/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('To'), 'draft');
    expect(await screen.findByText(/v0.9.0 → Draft/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('From'), 'draft');
    expect(await screen.findByText('No differences.')).toBeInTheDocument();
  });

  it('shows an empty version history', async () => {
    await renderApp(`/agents/${f.ids.agent2}?tab=versions`);
    expect(await screen.findByText('No published versions')).toBeInTheDocument();
  });

  it('starts a test run with an example event', async () => {
    let body: unknown;
    server.use(
      http.post(api('/v1/agents/:id/runs'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(f.run, { status: 202 });
      }),
    );
    const { user, router } = await renderApp(`${agentPath}?tab=test`);
    expect(await screen.findByText(/simulated provider/i)).toBeInTheDocument();
    const textarea = screen.getByLabelText('Example event (JSON)');
    await user.clear(textarea);
    await user.type(textarea, '{{ broken');
    await user.click(screen.getByRole('button', { name: 'Start test run' }));
    expect(await screen.findByText('This is not valid JSON.')).toBeInTheDocument();
    await user.clear(textarea);
    await user.type(textarea, '{{"ok":true}');
    await user.click(screen.getByRole('button', { name: 'Start test run' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${f.ids.run}`));
    expect(body).toEqual({ data: { ok: true }, version: '1.0.0' });
  });

  it('asks to publish before a test run', async () => {
    await renderApp(`/agents/${f.ids.agent2}?tab=test`);
    expect(await screen.findByText('Publish first')).toBeInTheDocument();
  });
});

describe('definition helpers', () => {
  it('reads loosely typed definitions defensively', () => {
    const d = readDefinition(f.versionDetail.definition);
    expect(d.agents[0]?.tools[1]).toEqual({
      server: 'tickets',
      tool: 'update_ticket',
      approval: true,
      maxCallsPerRun: 1,
      args: ['key', 'status'],
    });
    expect(d.triggers).toEqual([
      { type: 'webhook', detail: 'jira' },
      { type: 'cron', detail: '0 9 * * 1-5' },
    ]);
    const empty = readDefinition(null);
    expect(empty).toMatchObject({ agents: [], triggers: [], egress: [], budget: {} });
    expect(readDefinition({ agents: [{}], triggers: [{}] }).agents[0]).toMatchObject({
      id: '?',
      provider: '?',
    });
  });

  it('extracts hints from a draft', () => {
    expect(draftHints(f.draftSource)).toEqual({
      toolbox: 'jira-cli',
      runner: 'in-process',
      providers: ['simulated'],
    });
    expect(draftHints('nothing')).toEqual({ providers: [] });
  });

  it('builds example events from the trigger', () => {
    expect(JSON.parse(exampleEvent(f.versionDetail))).toMatchObject({ source: 'jira' });
    expect(
      JSON.parse(
        exampleEvent({
          ...f.versionDetail,
          definition: { triggers: [{ type: 'kafka', topic: 't' }] },
        }),
      ),
    ).toMatchObject({ topic: 't' });
    expect(JSON.parse(exampleEvent(undefined))).toHaveProperty('message');
  });
});
