import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import * as f from './fixtures';
import { api } from './handlers';
import * as r from './review-fixtures';
import { server } from './server';
import { renderApp } from './utils';

/** ADR 0017 S3: the publish dialog names the open review, explains refusals, and versions can be deprecated. */
const agentPath = `/agents/${f.ids.agent}`;
const json = (body: unknown, status = 200) => HttpResponse.json(body as never, { status });

async function openPublishDialog() {
  const { user } = await renderApp(`${agentPath}?tab=editor`);
  await user.click(await screen.findByRole('button', { name: 'Publish…' }));
  return { user, dialog: await screen.findByRole('dialog', { name: /publish ticket-updater/i }) };
}

describe('publish dialog', () => {
  it('names the open review and the revision, and shows where the approval stands', async () => {
    const rv = r.review();
    let sent: unknown;
    server.use(
      http.get(api('/v1/agents/:id/reviews'), () => json({ items: [rv], nextCursor: null })),
      http.post(api('/v1/agents/:id/publish'), async ({ request }) => {
        sent = await request.json();
        return json(
          { version: { ...f.versions[1]!, version: '1.1.0' }, created: true, approval: null },
          201,
        );
      }),
    );
    const { user, dialog } = await openPublishDialog();
    const line = await within(dialog).findByTestId('publish-approval');
    expect(line).toHaveTextContent('Approval is required: 0 of 1 approvals count now.');
    await user.click(within(dialog).getByLabelText(/i reviewed the changes/i));
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
    expect(await screen.findByText('Version 1.1.0 published.')).toBeInTheDocument();
    expect(sent).toEqual({ reviewId: rv.id, expectedDigest: rv.revision.digest });
  });

  it('hints at the review tab when there is no review', async () => {
    const { dialog } = await openPublishDialog();
    expect(await within(dialog).findByTestId('publish-approval')).toHaveTextContent(
      /request a review in the Review tab first/,
    );
  });

  it.each([
    ['approval_required', undefined, /Approval is required for this agent/],
    ['approval_insufficient', undefined, /does not have enough valid approvals/],
    ['approval_stale', { reason: 'expansion_changed' }, /tools behind the profiles/],
    ['approval_stale', { reason: 'secret_resolution_changed' }, /secrets this agent resolves/],
    ['draft_changed', undefined, /changed while you were publishing/],
    ['publisher_not_approver', undefined, /only an approver of the review publish/],
    ['role_bindings_read_required', undefined, /OAX_ROLE_BINDINGS_READ=bindings/],
  ])('explains the refusal %s in plain words', async (code, details, text) => {
    server.use(
      http.post(api('/v1/agents/:id/publish'), () =>
        json({ error: code, message: 'raw api text', details }, 409),
      ),
    );
    const { user, dialog } = await openPublishDialog();
    await user.click(within(dialog).getByLabelText(/i reviewed the changes/i));
    await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(within(dialog).queryByText('raw api text')).not.toBeInTheDocument();
  });
});

describe('versions: approval and deprecation', () => {
  const approvedV = { ...f.versions[1]!, reviewId: r.rid.review };
  const olderV = {
    ...f.versions[0]!,
    deprecated: { at: new Date().toISOString(), by: f.ids.admin, reason: null, rollbackTo: null },
  };

  it('marks approved and deprecated versions and rolls back from the latest', async () => {
    let called = '';
    server.use(
      http.get(api('/v1/agents/:id/versions'), () => json({ items: [olderV, approvedV] })),
      http.post(api('/v1/agents/:id/versions/:version/deprecate'), ({ params }) => {
        called = String(params.version);
        return json({
          versionId: approvedV.id,
          version: '1.0.0',
          deprecatedAt: new Date().toISOString(),
          rollbackTo: { id: olderV.id, version: '0.9.0' },
        });
      }),
    );
    const { user } = await renderApp(`${agentPath}?tab=versions`);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
    // only versions that are not deprecated can be deprecated
    const buttons = screen.getAllByRole('button', { name: 'Deprecate…' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Deprecate v1.0.0?' });
    expect(within(dialog).getByText(/This cannot be undone|cannot be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Deprecate version' }));
    expect(
      await screen.findByText('Version 1.0.0 deprecated. The agent is back on 0.9.0.'),
    ).toBeInTheDocument();
    expect(called).toBe('1.0.0');
  });

  it('explains a refused rollback', async () => {
    server.use(
      http.get(api('/v1/agents/:id/versions'), () => json({ items: [f.versions[0]!, approvedV] })),
      http.post(api('/v1/agents/:id/versions/:version/deprecate'), () =>
        json({ error: 'rollback_target_unapproved', message: 'raw' }, 409),
      ),
    );
    const { user } = await renderApp(`${agentPath}?tab=versions`);
    await user.click((await screen.findAllByRole('button', { name: 'Deprecate…' }))[1]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deprecate version' }));
    expect(
      await within(dialog).findByText(/No older version was published under an approved review/),
    ).toBeInTheDocument();
  });
});
