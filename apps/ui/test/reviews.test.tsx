import { configure, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeAll, describe, expect, it } from 'vitest';
import { LifecycleBadge } from '../src/features/reviews/LifecycleBadge';
import { lifecycleStatus } from '../src/features/reviews/lifecycleStatus';
import { ineligibility } from '../src/features/reviews/decisionReasons';
import {
  MAX_RENDERED_LINES,
  anchorOfLine,
  placeThreads,
  visibleRows,
} from '../src/features/reviews/threadPlacement';
import { I18nProvider, loadLocale } from '../src/i18n/i18n';
import { MAX_DIFF_CELLS, diffIsCoarse, diffLines } from '../src/lib/diff';
import * as f from './fixtures';
import { api } from './handlers';
import * as r from './review-fixtures';
import { server } from './server';
import { asViewer, expectNoA11yViolations, heading, renderApp } from './utils';

const path = `/agents/${f.ids.agent}?tab=review`;

// The Review tab is a lazy chunk: load it before the first test and give async queries room, so a
// busy machine (coverage, several workers) does not turn the first render into a timeout.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await import('../src/features/reviews/ReviewTab');
});
const json = (body: unknown, status = 200) => HttpResponse.json(body as never, { status });

/** An open review with its changes, threads and people on the server side of the test. */
function openReviewWith(
  opts: {
    review?: Partial<ReturnType<typeof r.review>>;
    threads?: ReturnType<typeof r.thread>[];
    changes?: ReturnType<typeof r.changes>;
    people?: Record<string, string>;
  } = {},
) {
  const rv = r.review(opts.review);
  server.use(
    http.get(api('/v1/agents/:id/reviews'), () => json({ items: [rv], nextCursor: null })),
    http.get(api('/v1/reviews/:id/changes'), () => json(opts.changes ?? r.changes())),
    http.get(api('/v1/reviews/:id/threads'), () => json({ items: opts.threads ?? [] })),
    http.get(api('/v1/reviews/:id/people'), () =>
      json({ people: opts.people ?? { [r.rid.other]: 'Olga Author', [f.ids.admin]: 'Ada Admin' } }),
    ),
  );
  return rv;
}

describe('status badges', () => {
  const agent = { status: 'changed' } as const;
  it.each([
    [{ status: 'open', state: 'review_requested' }, 'changed', 'review_requested'],
    [{ status: 'open', state: 'changes_requested' }, 'changed', 'changes_requested'],
    [{ status: 'open', state: 'approved' }, 'changed', 'approved'],
    [null, 'published', 'published'],
    [null, 'changed', 'in_development'],
    [null, 'draft', 'in_development'],
    [{ status: 'withdrawn', state: 'withdrawn' }, 'changed', 'in_development'],
    [{ status: 'rejected', state: 'rejected' }, 'changed', 'in_development'],
    [{ status: 'open', state: 'approved' }, 'published', 'approved'],
  ] as const)('maps %j on a %s agent to %s', (review, status, expected) => {
    expect(lifecycleStatus({ status }, review)).toBe(expected);
  });

  it('shows the five statuses as text, in English and German, and has no break-glass status', async () => {
    const labels = {
      en: ['In development', 'Review requested', 'Changes requested', 'Approved', 'Published'],
      de: [
        'In Entwicklung',
        'Review angefragt',
        'Änderungen gewünscht',
        'Freigegeben',
        'Veröffentlicht',
      ],
    } as const;
    const cases = [
      [agent, null],
      [agent, { status: 'open', state: 'review_requested' }],
      [agent, { status: 'open', state: 'changes_requested' }],
      [agent, { status: 'open', state: 'approved' }],
      [{ status: 'published' }, null],
    ] as const;
    for (const locale of ['en', 'de'] as const) {
      await loadLocale(locale);
      const { container, unmount } = render(
        <I18nProvider initialLocale={locale}>
          {cases.map(([a, rv], i) => (
            <LifecycleBadge key={i} agent={a} review={rv} />
          ))}
        </I18nProvider>,
      );
      expect(Array.from(container.querySelectorAll('.badge')).map((b) => b.textContent)).toEqual(
        labels[locale],
      );
      expect(container.textContent).not.toMatch(/break.?glass/i);
      unmount();
    }
  });

  it('shows the badge of the open review on the agent page', async () => {
    openReviewWith({ review: { state: 'changes_requested' } });
    await renderApp(`/agents/${f.ids.agent}`);
    await heading(/ticket-updater/);
    expect(await screen.findByText('Changes requested')).toBeInTheDocument();
  });
});

describe('the Review tab', () => {
  it('offers to request a review when there is none, and posts it', async () => {
    let posted = false;
    server.use(
      http.post(api('/v1/agents/:id/reviews'), () => {
        posted = true;
        return json(r.review(), 201);
      }),
    );
    const { user } = await renderApp(path);
    await heading(/ticket-updater/);
    expect(await screen.findByText('No review yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request review' }));
    await waitFor(() => expect(posted).toBe(true));
  });

  it('explains that a published draft has nothing to review and hides the button', async () => {
    server.use(http.get(api('/v1/agents/:id'), () => json({ ...f.agent, status: 'published' })));
    await renderApp(path);
    expect(await screen.findByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request review' })).not.toBeInTheDocument();
  });

  it('shows who asked, against what, and how many approvals are in', async () => {
    openReviewWith({
      review: {
        approvals: [
          {
            id: 'a6666666-6666-4666-8666-666666666666',
            reviewerId: f.ids.admin,
            decision: 'approve',
            revisionId: r.rid.revision,
            digest: 'd'.repeat(64),
            expansionDigest: 'e'.repeat(64),
            resolutionDigest: 'f'.repeat(64),
            baseVersionId: null,
            policyDigest: '9'.repeat(64),
            reviewerAuth: 'session',
            actingTenantId: r.rid.other,
            bindingRefs: [],
            comment: 'Please **narrow** the egress',
            decidedAt: new Date().toISOString(),
            expiresAt: null,
            current: true,
            counted: false,
            reasons: ['expired'],
          },
        ],
      },
    });
    await renderApp(path);
    const header = (await screen.findByRole('heading', { name: 'Review', level: 2 })).closest(
      'section',
    )!;
    expect(await within(header).findByText(/Olga Author/)).toBeInTheDocument();
    expect(within(header).getByText('v1.0.0')).toBeInTheDocument();
    expect(within(header).getByText('0 of 1')).toBeInTheDocument();
    expect(within(header).getByText('Does not count')).toBeInTheDocument();
    expect(within(header).getByText(/expired/)).toBeInTheDocument();
    // the reviewer's comment is shown, rendered as Markdown
    expect(within(header).getByText('narrow').tagName).toBe('STRONG');
    expect(within(header).getByText(/You · Approved|Approved/)).toBeInTheDocument();
  });

  it('shows the semantic summary: tools with access class, egress, references, budget, rules', async () => {
    openReviewWith();
    await renderApp(path);
    const summary = (await screen.findByRole('heading', { name: 'What changes' })).closest(
      'section',
    )!;
    const tools = within(summary).getByRole('table', { name: 'Tools and granted access' });
    const rows = within(tools).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('jira/get_issue')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Read')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('by profile jira:read')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Write')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Required per call')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Added')).toBeInTheDocument();
    expect(within(summary).getByText('api.example.org')).toBeInTheDocument();
    expect(within(summary).getByText('jira-token')).toBeInTheDocument();
    expect(within(summary).getByText(/scope: legacy/)).toBeInTheDocument();
    expect(within(summary).getByText('JIRA_TOKEN')).toBeInTheDocument();
    expect(within(summary).getByText('Cost (USD)')).toBeInTheDocument();
    expect(within(summary).getByText(/Agent rules are not available/)).toBeInTheDocument();
    // no value of any secret is ever on the page
    expect(summary.textContent).not.toMatch(/xoxb|sk-|password/i);
  });

  it('marks removed tools and unclassified access', async () => {
    const base = r.changes();
    const gone = {
      ...base.facts.head.tools[0]!,
      key: 'old/tool',
      server: 'old',
      tool: 'tool',
      profile: null,
    };
    openReviewWith({
      changes: r.changes({
        facts: {
          base: base.facts.base,
          head: {
            ...base.facts.head,
            tools: [{ ...base.facts.head.tools[0]!, access: 'unclassified' }],
          },
        },
        changes: { ...base.changes, tools: { added: [], removed: [gone], changed: [] } },
      }),
    });
    await renderApp(path);
    expect(await screen.findByText('Unclassified (treated as write)')).toBeInTheDocument();
    expect(screen.getByText('old/tool')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
  });

  it('is accessible and fully translated in German', async () => {
    openReviewWith({ threads: [r.thread({ comments: [r.comment({ body: 'Hallo **Welt**' })] })] });
    await renderApp(path, { locale: 'de' });
    expect(await screen.findByRole('heading', { name: 'Was sich ändert' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Deine Entscheidung' })).toBeInTheDocument();
    expect(screen.getByText('Diskussion')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('has no accessibility violations with threads, forms and the decision bar open', async () => {
    openReviewWith({
      threads: [
        r.thread({
          anchor: {
            side: 'head',
            line: 3,
            lineHash: 'c'.repeat(64),
            revisionId: r.rid.revision,
            revisionSeq: 2,
          },
          canResolve: true,
        }),
        r.thread({
          id: r.rid.thread2,
          comments: [r.comment({ id: r.rid.comment2, body: 'General note' })],
        }),
      ],
    });
    const { user } = await renderApp(path);
    await screen.findByText('General note');
    await user.click(
      screen.getAllByRole('button', { name: /Comment on (added|removed) line/ })[0]!,
    );
    await expectNoA11yViolations();
  });
});

describe('the decision bar', () => {
  it('lets an eligible reviewer decide, binding the decision to every digest on screen', async () => {
    const rv = openReviewWith();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(api('/v1/reviews/:id/decisions'), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return json({ review: rv, decision: {} }, 201);
      }),
    );
    const { user } = await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    const approve = within(bar).getByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(await within(bar).findByText('Your approval is recorded.')).toBeInTheDocument();
    expect(body).toEqual({
      decision: 'approve',
      expectedDigest: rv.revision.digest,
      expectedExpansionDigest: rv.digests.expansionDigest,
      expectedResolutionDigest: rv.digests.resolutionDigest,
      expectedPolicyDigest: rv.digests.policyDigest,
    });
  });

  it('needs a comment to request changes or reject, and sends it', async () => {
    const rv = openReviewWith();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(api('/v1/reviews/:id/decisions'), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return json({ review: rv, decision: {} }, 201);
      }),
    );
    const { user } = await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    for (const name of ['Request changes', 'Reject'])
      expect(within(bar).getByRole('button', { name })).toBeDisabled();
    await user.type(within(bar).getByLabelText(/Comment/), 'Please narrow the egress');
    await user.click(within(bar).getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(body['decision']).toBe('request_changes'));
    expect(body['comment']).toBe('Please narrow the egress');
  });

  it.each([
    ['self_approval', /You edited this draft or opened this review/],
    ['not_eligible', /Your role is not an approver role for this agent in this tenant/],
    ['binding_granted_by_contributor', /granted by somebody who contributed/],
    ['token_approval_disabled', /API token are not allowed/],
    ['actor_not_human', /Only a person can decide/],
    ['identity_source_not_allowed', /identity source cannot decide/],
    ['approver_scope', /approver scope of this tenant/],
  ])('says why %s is not allowed to decide, and disables the buttons', async (code, text) => {
    openReviewWith({ review: { you: { eligible: false, code, message: 'server text' } } });
    await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    const reason = within(bar).getByRole('note');
    expect(reason).toHaveTextContent(text);
    for (const name of ['Approve', 'Request changes', 'Reject']) {
      const button = within(bar).getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-describedby', reason.id);
    }
  });

  it.each([
    ['team', 'This rule needs a member of team Security.'],
    ['other-team', 'This rule needs a reviewer who is not a member of team Security.'],
  ] as const)('names the team when the approver scope is %s', async (scope, sentence) => {
    openReviewWith({
      review: { you: { eligible: false, code: 'approver_scope', message: 'x' } },
      changes: { ...r.changes(), policy: { ...r.changes().policy, approverScope: scope } },
    });
    await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    await waitFor(() => expect(within(bar).getByRole('note')).toHaveTextContent(sentence));
  });

  it('shows a closed review as closed and offers no decision bar', async () => {
    openReviewWith({
      review: { status: 'rejected', state: 'rejected', closedAt: new Date().toISOString() },
    });
    await renderApp(path);
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your decision' })).not.toBeInTheDocument();
  });

  it('tells the reviewer to reload when the draft changed under them', async () => {
    openReviewWith();
    server.use(
      http.post(api('/v1/reviews/:id/decisions'), () =>
        json({ error: 'stale_view', message: 'the draft changed' }, 409),
      ),
    );
    const { user } = await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    await user.click(within(bar).getByRole('button', { name: 'Approve' }));
    expect(await within(bar).findByRole('alert')).toHaveTextContent(
      /draft changed since you opened this page/i,
    );
  });

  it('can be reached and used with the keyboard', async () => {
    openReviewWith();
    const { user } = await renderApp(path);
    const bar = await screen.findByRole('region', { name: 'Your decision' });
    const comment = within(bar).getByLabelText(/Comment/);
    comment.focus();
    await user.keyboard('Needs work');
    await user.tab();
    expect(within(bar).getByRole('button', { name: 'Approve' })).toHaveFocus();
    await user.tab();
    expect(within(bar).getByRole('button', { name: 'Request changes' })).toHaveFocus();
  });

  it('lets a viewer read the review but not comment, and says they cannot decide', async () => {
    asViewer();
    openReviewWith({ review: { you: { eligible: false, code: 'not_eligible', message: 'x' } } });
    server.use(
      http.get(api('/v1/reviews/:id/threads'), () =>
        json({ error: 'forbidden', message: 'no' }, 403),
      ),
    );
    await renderApp(path);
    expect(await screen.findByText('Comments are not available to your role.')).toBeInTheDocument();
    const bar = screen.getByRole('region', { name: 'Your decision' });
    expect(within(bar).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Start discussion' })).not.toBeInTheDocument();
  });

  it('withdraws an open review after confirmation', async () => {
    const rv = openReviewWith({ review: { openedBy: f.ids.admin } });
    let withdrawn = false;
    server.use(
      http.post(api('/v1/reviews/:id/withdraw'), () => {
        withdrawn = true;
        return json({ ...rv, status: 'withdrawn' });
      }),
    );
    const { user } = await renderApp(path);
    await user.click(await screen.findByRole('button', { name: 'Withdraw review' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw review' }));
    await waitFor(() => expect(withdrawn).toBe(true));
  });
});

describe('threads on the diff', () => {
  const anchor = (side: 'head' | 'base', line: number, over = {}) => ({
    side,
    line,
    lineHash: 'c'.repeat(64),
    revisionId: side === 'head' ? r.rid.revision : null,
    revisionSeq: side === 'head' ? 2 : null,
    ...over,
  });

  it('shows a thread under its line, with the comment rendered as Markdown', async () => {
    openReviewWith({
      threads: [
        r.thread({
          anchor: anchor('head', 3),
          comments: [
            r.comment({
              body: 'Is **this** intended? See [the policy](https://docs.example.org/p)',
            }),
          ],
        }),
      ],
    });
    await renderApp(path);
    const thread = await screen.findByRole('article', { name: 'Thread: Line 3' });
    expect(within(thread).getByText('Olga Author')).toBeInTheDocument();
    expect(within(thread).getByText('this').tagName).toBe('STRONG');
    const link = within(thread).getByRole('link', { name: 'the policy' });
    expect(link).toHaveAttribute('href', 'https://docs.example.org/p');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(thread.closest('li')?.textContent).toContain('version: 1.0.1');
  });

  it('puts a thread of the base side under the deleted line', async () => {
    openReviewWith({
      threads: [r.thread({ anchor: anchor('base', 3), comments: [r.comment({ body: 'gone' })] })],
    });
    await renderApp(path);
    const thread = await screen.findByRole('article', { name: 'Thread: Line 3' });
    expect(thread.closest('li')?.textContent).toContain('version: 1.0.0');
  });

  it('lists an outdated thread apart, with its revision, and not on a line', async () => {
    openReviewWith({
      threads: [
        r.thread({
          anchor: anchor('head', 3, { revisionSeq: 1 }),
          outdated: true,
          comments: [r.comment({ body: 'old note' })],
        }),
      ],
    });
    await renderApp(path);
    const section = (await screen.findByRole('heading', { name: 'Outdated threads' })).closest(
      'section',
    )!;
    const thread = within(section).getByRole('article', { name: 'Thread: Line 3 of revision #1' });
    expect(within(thread).getByText('Outdated')).toBeInTheDocument();
    expect(within(thread).getByText('old note')).toBeInTheDocument();
    // not shown in the diff itself
    const diff = screen.getByRole('list', { name: 'Changed lines of agents.md' });
    expect(within(diff).queryByText('old note')).not.toBeInTheDocument();
  });

  it('starts a thread on a changed line with the revision that is on screen', async () => {
    openReviewWith();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(api('/v1/reviews/:id/threads'), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return json(r.thread(), 201);
      }),
    );
    const { user } = await renderApp(path);
    const diff = await screen.findByRole('list', { name: 'Changed lines of agents.md' });
    const added = within(diff).getAllByRole('button', { name: /Comment on (added|removed) line/ });
    expect(added.length).toBeGreaterThan(0);
    await user.click(within(diff).getByRole('button', { name: 'Comment on added line 3' }));
    await user.type(
      screen.getByLabelText('Comment on added line 3', { selector: 'textarea' }),
      'Why 1.0.1?',
    );
    await user.click(screen.getByRole('button', { name: 'Start thread' }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(body).toMatchObject({ body: 'Why 1.0.1?', anchor: { line: 3 } });
  });

  it('starts a discussion about the whole review and shows the API refusal in place', async () => {
    openReviewWith();
    server.use(
      http.post(api('/v1/reviews/:id/threads'), () =>
        json({ error: 'thread_limit_reached', message: 'a review has at most 200 threads' }, 409),
      ),
    );
    const { user } = await renderApp(path);
    await user.type(await screen.findByLabelText('Start a discussion'), 'Overall remark');
    await user.click(screen.getByRole('button', { name: 'Start discussion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/most threads it can have/);
  });

  it('counts characters and refuses a comment over 10,000', async () => {
    openReviewWith();
    const { user } = await renderApp(path);
    const box = await screen.findByLabelText('Start a discussion');
    await user.click(box);
    await user.paste('x'.repeat(10_001));
    expect(screen.getByText('10001 of 10000 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start discussion' })).toBeDisabled();
    expect(screen.getByText('A comment can have at most 10,000 characters.')).toBeInTheDocument();
  });

  it('resolves a thread when allowed, and hides the control otherwise', async () => {
    openReviewWith({
      threads: [
        r.thread({ canResolve: true }),
        r.thread({
          id: r.rid.thread2,
          canResolve: false,
          comments: [r.comment({ id: r.rid.comment2, body: 'other' })],
        }),
      ],
    });
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.patch(api('/v1/reviews/:id/threads/:tid'), async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return json(r.thread({ resolved: true }));
      }),
    );
    const { user } = await renderApp(path);
    const resolveButtons = await screen.findAllByRole('button', { name: 'Resolve' });
    expect(resolveButtons).toHaveLength(1);
    await user.click(resolveButtons[0]!);
    await waitFor(() => expect(patched).toEqual({ resolved: true }));
  });

  it('lets the author edit and delete only their own comment', async () => {
    openReviewWith({
      threads: [
        r.thread({
          comments: [
            r.comment({ authorId: f.ids.admin, body: 'mine' }),
            r.comment({ id: r.rid.comment2, authorId: r.rid.other, body: 'theirs' }),
          ],
        }),
      ],
    });
    let edited: Record<string, unknown> | null = null;
    let deleted = false;
    server.use(
      http.patch(api('/v1/reviews/:id/threads/:tid/comments/:cid'), async ({ request }) => {
        edited = (await request.json()) as Record<string, unknown>;
        return json(r.thread());
      }),
      http.delete(api('/v1/reviews/:id/threads/:tid/comments/:cid'), () => {
        deleted = true;
        return json(r.thread());
      }),
    );
    const { user } = await renderApp(path);
    await screen.findByText('theirs');
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit your comment');
    await user.clear(box);
    await user.type(box, 'mine, edited');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edited).toEqual({ body: 'mine, edited' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows a deleted comment as a tombstone and a resolved thread as resolved', async () => {
    openReviewWith({
      threads: [
        r.thread({
          resolved: true,
          resolvedBy: f.ids.admin,
          comments: [r.comment({ deleted: true, body: '' })],
        }),
      ],
    });
    await renderApp(path);
    expect(await screen.findByText('This comment was deleted.')).toBeInTheDocument();
    expect(screen.getByText('Resolved by You')).toBeInTheDocument();
  });

  it('renders a hostile comment as inert text', async () => {
    openReviewWith({
      threads: [
        r.thread({
          comments: [
            r.comment({
              body: '<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3)) ![y](https://evil.example/p.png)',
            }),
          ],
        }),
      ],
    });
    await renderApp(path);
    const thread = await screen.findByRole('article', { name: 'Thread: Whole review' });
    expect(thread.querySelector('img, script, a')).toBeNull();
    expect(thread.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(thread.textContent).toContain('[x](javascript:alert(3))');
  });
});

describe('threads that the diff does not show', () => {
  const anchored = (line: number) =>
    r.thread({
      anchor: {
        side: 'head',
        line,
        lineHash: 'c'.repeat(64),
        revisionId: r.rid.revision,
        revisionSeq: 2,
      },
      comments: [r.comment({ body: `note on ${line}` })],
    });

  it('lists a thread of an identical diff in its own section', async () => {
    openReviewWith({
      changes: r.changes({ base: { ...r.changes().base!, source: r.HEAD_SOURCE } }),
      threads: [anchored(3)],
    });
    await renderApp(path);
    const section = (
      await screen.findByRole('heading', { name: 'Threads not shown in the diff' })
    ).closest('section')!;
    expect(within(section).getByText('note on 3')).toBeInTheDocument();
    expect(
      await screen.findByText(/identical|no differences|nothing changed/i),
    ).toBeInTheDocument();
  });

  it('lists a thread below the cut of a huge diff in its own section', async () => {
    const head = Array.from({ length: 3200 }, (_, i) => `line ${i + 1}`).join('\n');
    openReviewWith({
      changes: r.changes({ headSource: head, base: { ...r.changes().base!, source: '' } }),
      threads: [anchored(3100)],
    });
    await renderApp(path);
    const section = (
      await screen.findByRole(
        'heading',
        { name: 'Threads not shown in the diff' },
        { timeout: 15000 },
      )
    ).closest('section')!;
    expect(within(section).getByText('note on 3100')).toBeInTheDocument();
    expect(screen.getByText(/first 3000 lines/)).toBeInTheDocument();
  }, 30000);
});

describe('the inbox', () => {
  it('lists the reviews you could decide and links them to the agent', async () => {
    server.use(
      http.get(api('/v1/me/reviews'), () =>
        json({
          items: [
            r.inboxItem(),
            r.inboxItem({
              reviewId: r.rid.other,
              agentName: 'cve-triage',
              state: 'changes_requested',
              yourDecision: 'request_changes',
            }),
          ],
        }),
      ),
    );
    await renderApp('/reviews');
    await heading('Reviews');
    const link = await screen.findByRole('link', { name: 'ticket-updater' });
    expect(link).toHaveAttribute('href', `/agents/${f.ids.agent}?tab=review`);
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
    expect(screen.getByText('Requested changes')).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it('is empty when nothing waits, and is in the navigation for approvers only', async () => {
    await renderApp('/reviews');
    expect(await screen.findByText('Nothing waits for you')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Reviews' }).length).toBeGreaterThan(0);
  });

  it('is not in the navigation for a viewer', async () => {
    asViewer();
    await renderApp('/agents');
    await heading('Agents');
    expect(screen.queryByRole('link', { name: 'Reviews' })).not.toBeInTheDocument();
  });
});

describe('pure helpers', () => {
  it('places threads under the lines of the diff and separates the rest', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc\nd');
    const mk = (side: 'head' | 'base', line: number, outdated = false) =>
      r.thread({
        id: `${side}${line}${outdated}`,
        anchor: { side, line, lineHash: 'c'.repeat(64), revisionId: null, revisionSeq: 1 },
        outdated,
      });
    const placed = placeThreads(lines, [
      mk('head', 2),
      mk('base', 2),
      mk('head', 4),
      mk('head', 99),
      mk('head', 1, true),
      r.thread({ id: 'general' }),
    ]);
    expect(placed.general.map((t) => t.id)).toEqual(['general']);
    expect(placed.outdated.map((t) => t.id)).toEqual(['head99false', 'head1true']);
    const at = (text: string) => lines.findIndex((l) => l.text === text);
    expect(placed.byLine.get(at('B'))?.map((t) => t.id)).toEqual(['head2false']);
    expect(placed.byLine.get(at('b'))?.map((t) => t.id)).toEqual(['base2false']);
    expect(placed.byLine.get(at('d'))?.map((t) => t.id)).toEqual(['head4false']);
  });

  it('comments on deleted lines on the base and everything else on the head', () => {
    expect(anchorOfLine({ type: 'del', text: 'x', oldNo: 4 })).toEqual({ side: 'base', line: 4 });
    expect(anchorOfLine({ type: 'add', text: 'x', newNo: 5 })).toEqual({ side: 'head', line: 5 });
    expect(anchorOfLine({ type: 'same', text: 'x', oldNo: 1, newNo: 2 })).toEqual({
      side: 'head',
      line: 2,
    });
    expect(anchorOfLine({ type: 'same', text: 'x' })).toBeNull();
  });

  it('maps every refusal to a reason, and a closed review to its own', () => {
    const open = { status: 'open' as const };
    expect(
      ineligibility({ ...open, you: { eligible: true, code: null, message: null } }, 'tenant'),
    ).toBeNull();
    expect(
      ineligibility(
        { status: 'withdrawn', you: { eligible: true, code: null, message: null } },
        'tenant',
      )?.key,
    ).toBe('reviews.decision.reasons.closed');
    expect(
      ineligibility({ ...open, you: { eligible: false, code: 'weird', message: null } }, 'tenant')
        ?.key,
    ).toBe('reviews.decision.reasons.unknown');
    expect(
      ineligibility(
        { ...open, you: { eligible: false, code: 'approver_scope', message: null } },
        'team',
      )?.scope,
    ).toBe('team');
    expect(
      ineligibility(
        { ...open, you: { eligible: false, code: 'approver_scope', message: null } },
        'tenant',
      )?.scope,
    ).toBeUndefined();
  });

  it('keeps the diff exact below the size limit and trims the common ends', () => {
    const a = ['keep', 'old', 'tail'].join('\n');
    const b = ['keep', 'new', 'tail'].join('\n');
    expect(diffIsCoarse(a, b)).toBe(false);
    expect(diffLines(a, b).map((l) => `${l.type}:${l.text}`)).toEqual([
      'same:keep',
      'del:old',
      'add:new',
      'same:tail',
    ]);
    expect(diffLines(a, b).map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [3, 3],
    ]);
  });

  it('falls back to removed-then-added lines for a diff too large to compute', () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 50;
    const a = Array.from({ length: side }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: side }, (_, i) => `b${i}`).join('\n');
    expect(diffIsCoarse(a, b)).toBe(true);
    const started = performance.now();
    const lines = diffLines(a, b);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(lines).toHaveLength(2 * side);
    expect(lines.slice(0, side).every((l) => l.type === 'del')).toBe(true);
    expect(lines.slice(side).every((l) => l.type === 'add')).toBe(true);
  });

  it('renders changed lines with context, collapses the rest and bounds the list', () => {
    const unchanged = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const lines = diffLines(
      unchanged.join('\n'),
      [...unchanged.slice(0, 25), 'changed', ...unchanged.slice(26)].join('\n'),
    );
    const { rows, clipped } = visibleRows(lines, new Set());
    expect(clipped).toBe(false);
    expect(rows.filter((x) => typeof x === 'number').length).toBeLessThan(12);
    expect(rows.some((x) => typeof x !== 'number')).toBe(true);
    // a line with a thread stays visible
    const withThread = visibleRows(lines, new Set([2]));
    expect(withThread.rows).toContain(2);
    const huge = diffLines(
      '',
      Array.from({ length: MAX_RENDERED_LINES + 10 }, (_, i) => `n${i}`).join('\n'),
    );
    const cut = visibleRows(huge, new Set());
    expect(cut.clipped).toBe(true);
    expect(cut.rows.filter((x) => typeof x === 'number')).toHaveLength(MAX_RENDERED_LINES);
  });
});
