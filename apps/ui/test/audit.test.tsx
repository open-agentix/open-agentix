import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

describe('audit trail', () => {
  it('lists entries, filters and shows redacted details', async () => {
    const queries: string[] = [];
    server.use(
      http.get(api('/v1/audit'), ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ items: f.auditEntries, nextCursor: null });
      }),
    );
    const { user, router } = await renderApp('/audit');
    await heading('Audit trail');
    expect(await screen.findByRole('button', { name: 'agent.published' })).toBeInTheDocument();
    expect(screen.getByText('Signed checkpoints')).toBeInTheDocument();
    await expectNoA11yViolations();
    await user.type(screen.getByLabelText('Run id'), f.ids.run);
    await user.type(screen.getByLabelText('Action'), 'step.tool_call');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ runId: f.ids.run, action: 'step.tool_call' }),
    );
    await waitFor(() => expect(queries.at(-1)).toContain('action=step.tool_call'));
    await user.click(screen.getByRole('button', { name: 'agent.published' }));
    const dialog = await screen.findByRole('dialog', { name: '#3 agent.published' });
    expect(within(dialog).getByText('prev0')).toBeInTheDocument();
    expect(within(dialog).getByText(/\[redacted\]/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Bearer xyz/)).not.toBeInTheDocument();
  });

  it('verifies the hash chain with a clear result', async () => {
    const { user } = await renderApp('/audit');
    await heading('Audit trail');
    await user.click(screen.getByRole('button', { name: 'Verify hash chain' }));
    expect(await screen.findByText('The audit trail is intact.')).toBeInTheDocument();
    expect(
      screen.getByText(/3 entries and 1 signed checkpoints checked; head is #3/),
    ).toBeInTheDocument();
  });

  it('reports tampering', async () => {
    server.use(
      http.post(api('/v1/audit/verify'), () =>
        HttpResponse.json({
          valid: false,
          checkedEntries: 3,
          checkedCheckpoints: 0,
          headSeq: 3,
          headHash: 'h',
          issues: [{ seq: 2, code: 'hash_mismatch', message: 'entry 2 was modified' }],
        }),
      ),
    );
    const { user } = await renderApp('/audit');
    await heading('Audit trail');
    await user.click(screen.getByRole('button', { name: 'Verify hash chain' }));
    expect(await screen.findByText('Tampering detected: 1 problem')).toBeInTheDocument();
    expect(screen.getByText(/entry 2 was modified/)).toBeInTheDocument();
  });

  it('shows verification errors', async () => {
    server.use(
      http.post(api('/v1/audit/verify'), () =>
        HttpResponse.json({ error: 'x', message: 'verify failed' }, { status: 500 }),
      ),
    );
    const { user } = await renderApp('/audit');
    await heading('Audit trail');
    await user.click(screen.getByRole('button', { name: 'Verify hash chain' }));
    expect(await screen.findByText(/verify failed/)).toBeInTheDocument();
  });

  it('exports NDJSON with the session token', async () => {
    let auth: string | null = null;
    server.use(
      http.get(api('/v1/audit/export'), ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse('{"seq":1}\n');
      }),
    );
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { user } = await renderApp(`/audit?runId=${f.ids.run}`);
    await heading('Audit trail');
    await user.click(screen.getByRole('button', { name: 'Export NDJSON' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(auth).toMatch(/^Bearer /);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    server.use(http.get(api('/v1/audit/export'), () => new HttpResponse(null, { status: 403 })));
    await user.click(screen.getByRole('button', { name: 'Export NDJSON' }));
    expect(await screen.findByText('HTTP 403')).toBeInTheDocument();
    click.mockRestore();
  });

  it('shows the empty state and hides actions without permission', async () => {
    asViewer();
    server.use(
      http.get(api('/v1/audit'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/audit/checkpoints'), () => HttpResponse.json({ items: [] })),
    );
    await renderApp('/audit');
    expect(await screen.findByText('No audit entries')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify hash chain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export NDJSON' })).not.toBeInTheDocument();
  });
});
