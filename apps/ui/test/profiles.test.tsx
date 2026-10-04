import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { readDefinition } from '../src/features/agents/definition';
import {
  accessProblems,
  readToolAccess,
  writeToolAccess,
} from '../src/features/connections/profiles';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

const jira = {
  ...f.connections[0]!,
  name: 'jira',
  config: {
    transport: 'in-memory',
    tools: { get_issue: { access: 'read' }, create_issue: { access: 'write' } },
    profiles: { read: ['get_issue'], write: ['create_issue'] },
  },
};

describe('profile helpers', () => {
  it('reads only well-formed entries and round-trips', () => {
    const a = readToolAccess({
      tools: { a: { access: 'read' }, b: { access: 'admin' }, c: 'read' },
      profiles: { p: ['a', 1], q: 'x' },
    });
    expect(a).toEqual({ tools: { a: 'read' }, profiles: { p: ['a'] } });
    expect(readToolAccess({ tools: ['legacy'] })).toEqual({ tools: {}, profiles: {} });
    expect(writeToolAccess({ url: 'x', tools: ['legacy'] }, a)).toEqual({
      url: 'x',
      tools: { a: { access: 'read' } },
      profiles: { p: ['a'] },
    });
    expect(writeToolAccess({ url: 'x' }, { tools: {}, profiles: {} })).toEqual({ url: 'x' });
  });
  it('flags entries the server would refuse', () => {
    expect(
      accessProblems({
        tools: { a: 'read', w: 'write' },
        profiles: { read: ['a', 'w'], other: ['ghost'] },
      }),
    ).toEqual(['read: w', 'other: ghost']);
  });
  it('maps expanded grants back to their profile', () => {
    const view = readDefinition({
      agents: [
        {
          id: 'a',
          access: 'read-only',
          tools: [
            { server: 'jira', tool: 'get_issue', args: {} },
            { server: 'jira', tool: 'other', args: {} },
          ],
        },
      ],
      expansion: [{ agentId: 'a', server: 'jira', profile: 'read', tools: ['get_issue'] }],
    });
    expect(view.agents[0]?.access).toBe('read-only');
    expect(view.agents[0]?.tools.map((t) => t.via)).toEqual(['jira:read', undefined]);
  });
});

describe('connections page: tool profiles', () => {
  it('shows access classes and profiles on the card', async () => {
    server.use(http.get(api('/v1/connections'), () => HttpResponse.json({ items: [jira] })));
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByText(/2 tools classified/));
    const table = screen.getByRole('table', { name: 'Classified tools' });
    expect(within(table).getByText('get_issue')).toBeInTheDocument();
    expect(within(table).getByText('Read')).toBeInTheDocument();
    expect(within(table).getByText('Write')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('edits profiles and sends them in the saved config', async () => {
    let body: { config?: Record<string, unknown> } = {};
    server.use(
      http.get(api('/v1/connections'), () => HttpResponse.json({ items: [jira] })),
      http.put(api('/v1/connections/:id'), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(jira);
      }),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit jira' });
    await user.type(within(dialog).getByLabelText('New tool name'), 'search_issues');
    await user.click(within(dialog).getByRole('button', { name: 'Add tool' }));
    await user.selectOptions(within(dialog).getByLabelText('Access of search_issues'), 'read');
    await user.type(within(dialog).getByLabelText('New profile name'), 'triage');
    await user.click(within(dialog).getByRole('button', { name: 'Add profile' }));
    const triage = within(dialog).getByRole('group', { name: 'triage' });
    await user.click(within(triage).getByRole('checkbox', { name: 'search_issues' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove tool create_issue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Connection jira saved.');
    expect(body.config).toMatchObject({
      tools: { get_issue: { access: 'read' }, search_issues: { access: 'read' } },
      profiles: { read: ['get_issue'], write: [], triage: ['search_issues'] },
    });
  });

  it('warns about a read profile with a write tool and removes profiles', async () => {
    server.use(
      http.get(api('/v1/connections'), () =>
        HttpResponse.json({
          items: [
            {
              ...jira,
              config: { ...jira.config, profiles: { read: ['get_issue', 'create_issue'] } },
            },
          ],
        }),
      ),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit jira' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('read: create_issue');
    await user.click(within(dialog).getByRole('button', { name: 'Remove profile read' }));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('agent overview: profile origin', () => {
  it('shows the access class of the step and the profile a grant came from', async () => {
    server.use(
      http.get(api('/v1/agents/:id/versions/:version'), () =>
        HttpResponse.json({
          ...f.versionDetail,
          definition: {
            ...f.versionDetail.definition,
            expansion: [
              { agentId: 'updater', server: 'tickets', profile: 'read', tools: ['get_ticket'] },
            ],
            agents: [
              {
                ...(f.versionDetail.definition as { agents: object[] }).agents[0],
                access: 'read-only',
              },
            ],
          },
        }),
      ),
    );
    await renderApp(`/agents/${f.ids.agent}`);
    await heading(/ticket-updater/);
    expect(await screen.findByText('(from profile tickets:read)')).toBeInTheDocument();
    expect(screen.getByText('Read-only (no write tools)')).toBeInTheDocument();
  });
});
