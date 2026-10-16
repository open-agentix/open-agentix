import type { ReactNode } from 'react';
import type { ReviewChanges } from '../../api/types';
import { Badge, Code, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';

type Tool = ReviewChanges['facts']['head']['tools'][number];
type Mark = 'added' | 'removed' | 'changed' | null;

function MarkBadge({ mark }: { mark: Mark }) {
  const { t } = useI18n();
  if (!mark) return null;
  const tone = mark === 'added' ? 'success' : mark === 'removed' ? 'danger' : 'warning';
  return <Badge tone={tone}>{t(`reviews.summary.mark.${mark}`)}</Badge>;
}

function AccessBadge({ access }: { access: Tool['access'] }) {
  const { t } = useI18n();
  return (
    <Badge tone={access === 'read' ? 'success' : access === 'write' ? 'warning' : 'danger'}>
      {t(`reviews.summary.access.${access}`)}
    </Badge>
  );
}

function ToolsTable({
  changes,
  head,
}: {
  changes: ReviewChanges['changes']['tools'];
  head: Tool[];
}) {
  const { t } = useI18n();
  const added = new Set(changes.added.map((x) => x.key));
  const changed = new Set(changes.changed.map((x) => x.to.key));
  const rows: [Tool, Mark][] = [
    ...head.map((x): [Tool, Mark] => [
      x,
      added.has(x.key) ? 'added' : changed.has(x.key) ? 'changed' : null,
    ]),
    ...changes.removed.map((x): [Tool, Mark] => [x, 'removed']),
  ];
  if (rows.length === 0) return <p className="muted">{t('reviews.summary.noTools')}</p>;
  return (
    <table className="table">
      <caption className="sr-only">{t('reviews.summary.tools')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('reviews.summary.tool')}</th>
          <th scope="col">{t('reviews.summary.accessClass')}</th>
          <th scope="col">{t('reviews.summary.approval')}</th>
          <th scope="col">{t('reviews.summary.origin')}</th>
          <th scope="col">{t('reviews.summary.change')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([x, mark]) => (
          <tr key={`${x.key}-${mark ?? 'same'}`}>
            <th scope="row">
              <Code>{x.key}</Code>
            </th>
            <td>
              <AccessBadge access={x.access} />
            </td>
            <td>
              {x.approval === 'required'
                ? t('reviews.summary.approvalRequired')
                : t('reviews.summary.approvalNone')}
            </td>
            <td>
              {x.profile
                ? t('reviews.summary.viaProfile', { profile: x.profile })
                : t('reviews.summary.direct')}
            </td>
            <td>
              <MarkBadge mark={mark} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HostList({ hosts, removed }: { hosts: string[]; removed: string[] }) {
  const { t } = useI18n();
  if (hosts.length + removed.length === 0)
    return <p className="muted">{t('reviews.summary.noEgress')}</p>;
  return (
    <ul className="plain-list">
      {hosts.map((h) => (
        <li key={h}>
          <Code>{h}</Code>
        </li>
      ))}
      {removed.map((h) => (
        <li key={`-${h}`}>
          <Code>{h}</Code> <MarkBadge mark="removed" />
        </li>
      ))}
    </ul>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="summary-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/**
 * What the reviewer must look at besides the text: tools and their access class, egress, secret
 * references (names only), budget, classification, runtime and owner, with what changed against
 * the base version marked in words. Expanded grants are the tools of the head with the profile
 * each came from.
 */
export function SemanticSummary({ changes }: { changes: ReviewChanges }) {
  const { t } = useI18n();
  const head = changes.facts.head;
  const c = changes.changes;
  const newRefs = new Set(c.secretReferences.added.map((s) => s.name));
  const changedScalars = new Map(c.scalars.map((s) => [s.field, s]));
  const scalar = (field: string, value: ReactNode) => (
    <>
      {value} {changedScalars.has(field) ? <MarkBadge mark="changed" /> : null}
    </>
  );
  return (
    <Section title={t('reviews.summary.title')}>
      <Group title={t('reviews.summary.tools')}>
        <ToolsTable changes={c.tools} head={head.tools} />
      </Group>
      <Group title={t('reviews.summary.egress')}>
        <HostList hosts={head.egress} removed={c.egress.removed} />
      </Group>
      <Group title={t('reviews.summary.secrets')}>
        {head.secretReferences.length + c.secretReferences.removed.length === 0 ? (
          <p className="muted">{t('reviews.summary.noSecrets')}</p>
        ) : (
          <ul className="plain-list">
            {head.secretReferences.map((s) => (
              <li key={s.name}>
                <Code>{s.name}</Code> · {t('reviews.summary.scopeLegacy')} ·{' '}
                {t('reviews.summary.ownerNode')}: {'–'}
                {s.env ? (
                  <>
                    {' '}
                    · <Code>{s.env}</Code>
                  </>
                ) : null}{' '}
                {newRefs.has(s.name) ? <MarkBadge mark="added" /> : null}
              </li>
            ))}
            {c.secretReferences.removed.map((s) => (
              <li key={`-${s.name}`}>
                <Code>{s.name}</Code> <MarkBadge mark="removed" />
              </li>
            ))}
          </ul>
        )}
      </Group>
      <Group title={t('reviews.summary.budget')}>
        <dl className="kv">
          {Object.entries(head.budget).map(([k, v]) => (
            <div key={k}>
              <dt>
                {t(`reviews.summary.budgetKeys.${k}` as 'reviews.summary.budgetKeys.maxTokens')}
              </dt>
              <dd>{scalar(`budget.${k}`, v ?? t('reviews.summary.unlimited'))}</dd>
            </div>
          ))}
        </dl>
      </Group>
      <Group title={t('reviews.summary.general')}>
        <dl className="kv">
          <div>
            <dt>{t('reviews.summary.classification')}</dt>
            <dd>{scalar('classification', head.classification)}</dd>
          </div>
          <div>
            <dt>{t('reviews.summary.runtime')}</dt>
            <dd>
              {scalar('runtime.runner', head.runtime.runner)}
              {head.runtime.toolbox ? ` · ${head.runtime.toolbox}` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('reviews.summary.owner')}</dt>
            <dd>{scalar('owner', head.owner)}</dd>
          </div>
          <div>
            <dt>{t('reviews.summary.useCase')}</dt>
            <dd>{scalar('useCase', head.useCase ?? '–')}</dd>
          </div>
        </dl>
      </Group>
      <Group title={t('reviews.summary.rules')}>
        <p className="muted">{t('reviews.summary.rulesUnavailable')}</p>
      </Group>
    </Section>
  );
}
