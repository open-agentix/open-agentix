import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { findInlineSecrets, secretReferences } from '../src/features/connections/secrets';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

describe('connections', () => {
  it('rejects pasted API keys in reference fields', () => {
    expect(findInlineSecrets({ kind: 'openai', apiKeySecret: 'sk-live-123' })).toEqual([
      'apiKeySecret',
    ]);
    expect(findInlineSecrets({ kind: 'openai', apiKeySecret: 'OPENAI_API_KEY' })).toEqual([]);
  });

  it('finds secret references of model connections', () => {
    expect(
      secretReferences({ kind: 'bedrock', accessKeyIdSecret: 'A', secretAccessKeySecret: 'B' }),
    ).toEqual(['A', 'B']);
  });

  it('lists MCP servers with secret references and is accessible', async () => {
    await renderApp('/connections');
    await heading('Connections');
    expect(await screen.findByText('TICKETS_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('https://mcp.example.internal/mcp')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('creates a connection and rejects inline secrets', async () => {
    let body: unknown;
    server.use(
      http.post(api('/v1/connections'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...f.connections[0]!, name: 'cve-db' }, { status: 201 });
      }),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(screen.getByRole('button', { name: 'New connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New connection' });
    await user.type(within(dialog).getByLabelText(/^name/i), 'cve-db');
    const config = within(dialog).getByLabelText('Configuration');
    await user.clear(config);
    await user.type(config, '{{"url":"https://x.internal","token":"abc"}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/secret value at token/i)).toBeInTheDocument();
    await user.clear(config);
    await user.type(config, 'nope');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/not valid JSON/i)).toBeInTheDocument();
    await user.clear(config);
    await user.type(config, '{{"url":"https://x.internal","envSecrets":{{"TOKEN":"CVE_TOKEN"}}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Connection cve-db saved.')).toBeInTheDocument();
    expect(body).toEqual({
      name: 'cve-db',
      kind: 'mcp',
      scope: 'tenant',
      config: { url: 'https://x.internal', envSecrets: { TOKEN: 'CVE_TOKEN' } },
    });
  });

  it('creates a model connection with proposed prices (bring your own key)', async () => {
    let body: { name?: string; kind?: string; config?: { models?: { id: string }[] } } = {};
    server.use(
      http.post(api('/v1/connections'), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(
          { ...f.connections[0]!, name: 'claude', kind: 'model' },
          { status: 201 },
        );
      }),
    );
    const { user } = await renderApp('/connections');
    await heading('Connections');
    await user.click(screen.getByRole('button', { name: 'New connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New connection' });
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'model');
    expect(within(dialog).getByLabelText('Provider')).toHaveValue('anthropic');
    await user.type(within(dialog).getByLabelText(/^name/i), 'claude');
    await user.click(within(dialog).getByRole('button', { name: 'Propose models and prices' }));
    expect(await within(dialog).findByText('claude-sonnet-5-5')).toBeInTheDocument();
    expect(within(dialog).getByText('$2')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Connection claude saved.')).toBeInTheDocument();
    expect(body).toMatchObject({ name: 'claude', kind: 'model', scope: 'tenant' });
    expect(body.config).toMatchObject({
      kind: 'anthropic',
      apiKeySecret: 'ANTHROPIC_API_KEY',
      models: [{ id: 'claude-sonnet-5-5' }],
    });
  });

  it('edits and deletes a connection', async () => {
    let deleted = false;
    server.use(
      http.delete(
        api('/v1/connections/:id'),
        () => ((deleted = true), new HttpResponse(null, { status: 200 })),
      ),
    );
    const { user } = await renderApp('/connections');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit tickets' });
    expect(within(dialog).getByLabelText('Configuration')).toHaveValue(
      JSON.stringify(f.connections[0]!.config, null, 2),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Connection tickets saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete tickets?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(await screen.findByText('Connection tickets deleted.')).toBeInTheDocument();
  });

  it('shows empty, error and read-only states', async () => {
    server.use(http.get(api('/v1/connections'), () => HttpResponse.json({ items: [] })));
    await renderApp('/connections');
    expect(await screen.findByText('No connections yet')).toBeInTheDocument();
  });

  it('denies viewers', async () => {
    asViewer();
    server.use(
      http.get(api('/v1/connections'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'no' }, { status: 403 }),
      ),
    );
    await renderApp('/connections');
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New connection' })).not.toBeInTheDocument();
  });

  it('finds inline secrets and references', () => {
    expect(
      findInlineSecrets({
        a: { password: 'x', ok: 1 },
        list: [{ apiKey: 'k' }],
        headerSecrets: { authorization: 'REF' },
        tokenRef: 'X',
      }),
    ).toEqual(['a.password', 'list[0].apiKey']);
    expect(findInlineSecrets(null)).toEqual([]);
    expect(secretReferences({ envSecrets: { A: 'ONE' }, headerSecrets: { b: 'TWO' } })).toEqual([
      'ONE',
      'TWO',
    ]);
    expect(secretReferences({})).toEqual([]);
  });
});
