import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { describeCron } from '../src/features/events/cron';
import { translate } from '../src/i18n/i18n';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('events and sources', () => {
  it('shows webhook URLs, secret references, Kafka topics, schedules and recent events', async () => {
    const { user } = await renderApp('/events');
    await heading('Events & sources');
    expect(await screen.findByText(f.sources[0]!.ingestUrl!)).toBeInTheDocument();
    expect(screen.getByText('JIRA_WEBHOOK_SECRET')).toBeInTheDocument();
    expect(screen.getByText('security.scans')).toBeInTheDocument();
    expect(await screen.findByText('weekdays at 09:00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy ingest URL' }));
    expect(await navigator.clipboard.readText()).toBe(f.sources[0]!.ingestUrl);
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.click(
      await screen.findByRole('button', { name: 'com.atlassian.jira.issue.updated' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/"\[redacted\]"/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/hunter2/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it('toggles a source optimistically and rolls back on error', async () => {
    let calls = 0;
    server.use(
      http.patch(api('/v1/event-sources/:id'), () => {
        calls++;
        return HttpResponse.json({ error: 'x', message: 'nope' }, { status: 500 });
      }),
    );
    const { user } = await renderApp('/events');
    const toggle = await screen.findByLabelText('Accept events for jira');
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(await screen.findByText('nope')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Accept events for jira')).toBeChecked());
    expect(calls).toBe(1);
  });

  it('creates a webhook and a Kafka source with secret references only', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(api('/v1/event-sources'), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...f.sources[0]!, name: 'github' }, { status: 201 });
      }),
    );
    const { user } = await renderApp('/events');
    await heading('Events & sources');
    await user.click(screen.getByRole('button', { name: 'New source' }));
    let dialog = await screen.findByRole('dialog', { name: 'New source' });
    await user.type(within(dialog).getByLabelText(/^name/i), 'github');
    await user.selectOptions(within(dialog).getByLabelText('Signature scheme'), 'github');
    await user.type(within(dialog).getByLabelText('Secret reference'), 'GH_SECRET');
    await user.selectOptions(within(dialog).getByLabelText('Route to'), f.ids.agent);
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Source github created.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New source' }));
    dialog = await screen.findByRole('dialog', { name: 'New source' });
    await user.clear(within(dialog).getByLabelText(/^name/i));
    await user.type(within(dialog).getByLabelText(/^name/i), 'scans');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'kafka');
    await user.type(within(dialog).getByLabelText('Topic'), 'security.scans');
    server.use(
      http.post(api('/v1/event-sources'), () =>
        HttpResponse.json({ error: 'conflict', message: 'exists' }, { status: 409 }),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('exists')).toBeInTheDocument();
    expect(bodies[0]).toEqual({
      name: 'github',
      kind: 'webhook',
      scheme: 'github',
      secretRefs: ['GH_SECRET'],
      agentId: f.ids.agent,
      enabled: true,
    });
  });

  it('shows empty states', async () => {
    server.use(
      http.get(api('/v1/event-sources'), () => HttpResponse.json({ items: [] })),
      http.get(api('/v1/events'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/agents'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/events');
    expect(await screen.findByText('No inbound sources')).toBeInTheDocument();
    expect(screen.getByText('No Kafka sources')).toBeInTheDocument();
    expect(await screen.findByText('No scheduled agents')).toBeInTheDocument();
    expect(await screen.findByText('No events received yet')).toBeInTheDocument();
  });

  it('shows load errors', async () => {
    server.use(
      http.get(api('/v1/event-sources'), () =>
        HttpResponse.json({ error: 'x', message: 'down' }, { status: 500 }),
      ),
      http.get(api('/v1/events'), () =>
        HttpResponse.json({ error: 'x', message: 'down too' }, { status: 500 }),
      ),
    );
    await renderApp('/events');
    expect(await screen.findByText('down')).toBeInTheDocument();
    expect(await screen.findByText('down too')).toBeInTheDocument();
  });

  it('describes cron expressions', () => {
    const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) =>
      translate('en', k, v);
    expect(describeCron('15 * * * *', t)).toBe('every hour at minute 15');
    expect(describeCron('*/5 * * * *', t)).toBe('every 5 minutes');
    expect(describeCron('0 9 * * *', t)).toBe('every day at 09:00');
    expect(describeCron('30 6 * * 1', t)).toBe('every Monday at 06:30');
    expect(describeCron('0 3 1 * *', t)).toBe('monthly on day 1 at 03:00');
    expect(describeCron('0 0 1 1 *', t)).toBe('0 0 1 1 *');
    expect(describeCron('@daily', t)).toBe('@daily');
  });
});
