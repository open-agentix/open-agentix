import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { reasonsText } from '../src/features/runs/ApprovalCard';
import { runDurationMs } from '../src/features/runs/RunDetailPage';
import { handoverSummary, policyOutcome } from '../src/features/runs/StepTimeline';
import { mergeSteps } from '../src/features/runs/useRunStream';
import * as f from './fixtures';
import { api } from './handlers';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
}

describe('runs list', () => {
  it('lists runs, filters by status and agent and is accessible', async () => {
    const seen: string[] = [];
    server.use(
      http.get(api('/v1/runs'), ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json({ items: [f.run, f.finishedRun], nextCursor: null });
      }),
    );
    const { user, router } = await renderApp('/runs');
    await heading('Runs');
    const table = await screen.findByRole('table', { name: 'Runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(within(table).getAllByText('ticket-updater').length).toBe(2);
    await expectNoA11yViolations();
    await user.selectOptions(screen.getByLabelText('Status'), 'failed');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ status: 'failed' }));
    await user.selectOptions(await screen.findByLabelText('Agent'), f.ids.agent);
    await waitFor(() =>
      expect(
        seen.some((s) => s.includes(`agentId=${f.ids.agent}`) && s.includes('status=failed')),
      ).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText('Status'), '');
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty('status', 'failed'),
    );
  });

  it('loads more pages with the keyset cursor', async () => {
    const page2 = { ...f.finishedRun, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    server.use(
      http.get(api('/v1/runs'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return cursor
          ? HttpResponse.json({ items: [page2], nextCursor: null })
          : HttpResponse.json({ items: [f.run], nextCursor: 'c1' });
      }),
    );
    await renderApp('/runs');
    expect(await screen.findByRole('link', { name: '#eeeeeeee' })).toBeInTheDocument();
    expect(screen.getByText('2 loaded')).toBeInTheDocument();
  });

  it('shows empty and error states', async () => {
    server.use(
      http.get(api('/v1/runs'), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(api('/v1/approvals'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp('/runs');
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    server.use(
      http.get(api('/v1/runs'), () =>
        HttpResponse.json({ error: 'x', message: 'db down' }, { status: 500 }),
      ),
    );
  });

  it('approves a pending tool call optimistically', async () => {
    let decision: unknown;
    server.use(
      http.post(api('/v1/approvals/:id/decision'), async ({ request }) => {
        decision = await request.json();
        return HttpResponse.json({ ...f.approval, status: 'approved' });
      }),
    );
    const { user } = await renderApp('/runs');
    const panel = await screen.findByRole('region', { name: /1 approval pending/i });
    expect(within(panel).getByText('tickets/update_ticket')).toBeInTheDocument();
    expect(within(panel).queryByText(/should-not-show/)).not.toBeInTheDocument();
    expect(within(panel).getByText('update_ticket requires approval')).toBeInTheDocument();
    await user.type(within(panel).getByLabelText(/comment/i), 'looks fine');
    server.use(
      http.get(api('/v1/approvals'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await user.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Tool call approved.')).toBeInTheDocument();
    expect(decision).toEqual({ decision: 'approve', comment: 'looks fine' });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /approval pending/i })).not.toBeInTheDocument(),
    );
  });

  it('rolls back a failed denial', async () => {
    server.use(
      http.post(api('/v1/approvals/:id/decision'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'not your team' }, { status: 403 }),
      ),
    );
    const { user } = await renderApp('/runs');
    const panel = await screen.findByRole('region', { name: /1 approval pending/i });
    await user.click(within(panel).getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('not your team')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /1 approval pending/i })).toBeInTheDocument();
  });

  it('tells viewers they cannot decide', async () => {
    asViewer();
    await renderApp('/runs');
    expect(await screen.findByText(/can't decide on approvals/i)).toBeInTheDocument();
  });
});

describe('run detail', () => {
  it('follows a running run live over SSE', async () => {
    const running = { ...f.run, status: 'running' as const };
    const step4 = {
      ...f.steps[2]!,
      seq: 4,
      kind: 'output',
      name: 'markdown',
      status: 'ok',
      input: null,
      output: { content: 'done' },
      durationMs: null,
    };
    server.use(
      http.get(api('/v1/runs/:id'), () => HttpResponse.json(running)),
      http.get(api('/v1/runs/:id/stream'), ({ request }) => {
        expect(request.headers.get('authorization')).toMatch(/^Bearer /);
        expect(request.headers.get('last-event-id')).toBe('3');
        return sse([
          `id: 4\nevent: step\ndata: ${JSON.stringify(step4)}\n\n`,
          'event: status\ndata: {"status":"awaiting_approval"}\n\n',
          `event: end\ndata: ${JSON.stringify({ ...running, status: 'succeeded', finishedAt: new Date().toISOString(), outputs: [{ agentId: 'updater', format: 'markdown', content: 'All done' }] })}\n\n`,
        ]);
      }),
    );
    await renderApp(`/runs/${f.ids.run}`);
    await heading(/ticket-updater/);
    expect(
      await screen.findByText('markdown', { selector: '.step-head .mono' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('All done')).toBeInTheDocument();
    expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('shows the timeline with audit-gate reasons, costs and redacted inputs', async () => {
    const { user } = await renderApp(`/runs/${f.ids.run}`);
    await heading(/ticket-updater/);
    expect(
      await screen.findByText('Audit gate: Denied: tool not in allowlist'),
    ).toBeInTheDocument();
    expect(screen.getByText('Model call')).toBeInTheDocument();
    expect(screen.getAllByText('1,200 in / 300 out').length).toBeGreaterThan(0);
    expect(screen.getByText('850 ms')).toBeInTheDocument();
    const toolStep = screen.getByText('tickets/get_ticket').closest('li')!;
    await user.click(within(toolStep).getByText('Input'));
    expect(within(toolStep).getByText(/\[redacted\]/)).toBeInTheDocument();
    expect(within(toolStep).queryByText(/secret-value/)).not.toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'Waiting for a decision' });
    expect(within(waiting).getByText('tickets/update_ticket')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /audit trail of this run/i })).toHaveAttribute(
      'href',
      `/audit?runId=${f.ids.run}`,
    );
    await expectNoA11yViolations();
  });

  it('cancels after confirmation', async () => {
    const { user } = await renderApp(`/runs/${f.ids.run}`);
    await heading(/ticket-updater/);
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this run?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Run cancelled.')).toBeInTheDocument();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });

  it('shows errors and outputs of a finished run with redaction', async () => {
    await renderApp(`/runs/${f.ids.run2}`);
    await heading(/ticket-updater/);
    expect(await screen.findByText('tool_error')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Upstream failed with [redacted]');
    expect(screen.getByText('Ticket SEC-42 moved.')).toBeInTheDocument();
  });

  it('reports a lost live connection', async () => {
    server.use(
      http.get(api('/v1/runs/:id'), () => HttpResponse.json({ ...f.run, status: 'running' })),
      http.get(api('/v1/runs/:id/stream'), () =>
        HttpResponse.json({ error: 'forbidden', message: 'no' }, { status: 403 }),
      ),
      http.get(api('/v1/runs/:id/steps'), () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await renderApp(`/runs/${f.ids.run}`);
    expect(await screen.findByText('Live updates lost', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/waiting for a worker/i)).toBeInTheDocument();
  });

  it('shows a not-found run', async () => {
    server.use(
      http.get(api('/v1/runs/:id'), () =>
        HttpResponse.json({ error: 'not_found', message: 'run not found' }, { status: 404 }),
      ),
    );
    await renderApp(`/runs/${f.ids.run}`);
    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
  });
});

describe('skipped steps and handover failures', () => {
  const base = { ...f.steps[2]!, agentId: 'action', input: null, tokensIn: 0, tokensOut: 0 };
  const skipped = {
    ...base,
    seq: 4,
    kind: 'condition',
    name: 'when',
    status: 'skipped',
    output: { when: 'steps.analysis.output.severity == "high"' },
  } as (typeof f.steps)[number];
  const invalid = {
    ...base,
    seq: 5,
    kind: 'handover',
    name: 'output',
    status: 'error',
    output: {
      direction: 'output',
      attempt: 1,
      schemaDigest: 'abc',
      errors: [
        { instancePath: '/severity', keyword: 'enum', schemaPath: '#/enum' },
        { instancePath: '', keyword: 'required', schemaPath: '#/required' },
      ],
    },
  } as (typeof f.steps)[number];

  it('summarises condition and handover steps without values', () => {
    expect(handoverSummary(skipped)).toEqual({
      outcome: 'skipped',
      direction: null,
      detail: 'steps.analysis.output.severity == "high"',
      violations: 0,
    });
    expect(handoverSummary({ ...skipped, status: 'error', output: { reason: 'no path' } })).toEqual(
      { outcome: 'conditionError', direction: null, detail: 'no path', violations: 0 },
    );
    expect(handoverSummary(invalid)).toMatchObject({
      outcome: 'invalid',
      direction: 'output',
      violations: 2,
    });
    expect(
      handoverSummary({
        ...invalid,
        name: 'input',
        output: { direction: 'input', errors: [{ keyword: 'missing' }] },
      }),
    ).toMatchObject({ outcome: 'missing', direction: 'input' });
    expect(handoverSummary({ ...invalid, name: 'retry', output: null })).toMatchObject({
      outcome: 'retry',
      violations: 0,
    });
    expect(handoverSummary({ ...skipped, kind: 'output', output: null })).toBeNull();
    expect(handoverSummary({ ...skipped, output: null })).toMatchObject({
      outcome: 'skipped',
      detail: '',
    });
  });

  it('lists skipped steps and handover failures in the run timeline', async () => {
    server.use(
      http.get(api('/v1/runs/:id/steps'), () =>
        HttpResponse.json({ items: [...f.steps, skipped, invalid], nextCursor: null }),
      ),
    );
    await renderApp(`/runs/${f.ids.run}`);
    await heading(/ticket-updater/);
    expect(
      await screen.findByText(
        'Step skipped, condition is false: steps.analysis.output.severity == "high"',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The output does not match its schema (2 violations). Values are never logged.',
      ),
    ).toBeInTheDocument();
  });
});

describe('run helpers', () => {
  it('merges steps by sequence number', () => {
    const merged = mergeSteps(
      [f.steps[1]!, f.steps[0]!],
      [{ ...f.steps[1]!, status: 'ok' }, f.steps[2]!],
    );
    expect(merged.map((s) => `${s.seq}:${s.status}`)).toEqual(['1:ok', '2:ok', '3:ok']);
  });

  it('reads policy outcomes and reasons', () => {
    expect(policyOutcome(f.steps[1]!)).toEqual({
      effect: 'deny',
      reasons: ['tool not in allowlist'],
    });
    expect(policyOutcome(f.steps[0]!)).toBeNull();
    expect(policyOutcome({ ...f.steps[1]!, output: { reasons: 'x' } })).toEqual({
      effect: 'denied',
      reasons: [],
    });
    expect(reasonsText(['plain', { message: 'm' }])).toEqual(['plain', 'm']);
    expect(reasonsText(null)).toEqual([]);
  });

  it('computes durations', () => {
    expect(runDurationMs({ ...f.run, startedAt: null })).toBeNull();
    expect(
      runDurationMs({
        ...f.run,
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:02Z',
      }),
    ).toBe(2000);
    expect(
      runDurationMs(
        { ...f.run, startedAt: '2026-01-01T00:00:00Z', finishedAt: null },
        Date.parse('2026-01-01T00:00:01Z'),
      ),
    ).toBe(1000);
  });
});
