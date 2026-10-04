import type { ReactNode } from 'react';
import type { Agent, AgentVersionDetail } from '../../api/types';
import { Badge, Code, KeyValue, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { draftHints, readDefinition } from './definition';

export function OverviewTab({
  agent,
  latest,
}: {
  agent: Agent;
  latest: AgentVersionDetail | undefined;
}) {
  const { t, fmt } = useI18n();
  if (!latest) {
    const hints = draftHints(agent.draftSource);
    return (
      <Section title={t('agents.overview.draftTitle')}>
        <p className="muted">{t('agents.overview.draftText')}</p>
        <KeyValue
          items={[
            [t('agents.overview.runner'), hints.runner ?? 'in-process'],
            [t('agents.overview.toolbox'), hints.toolbox ?? t('agents.overview.noToolbox')],
            [t('agents.overview.providers'), hints.providers.join(', ') || '–'],
          ]}
        />
      </Section>
    );
  }
  const d = readDefinition(latest.definition);
  return (
    <div className="stack">
      <div className="grid-2">
        <Section title={t('agents.overview.definition')}>
          <KeyValue
            items={[
              [t('agents.overview.version'), `v${latest.version}`],
              [t('agents.overview.published'), fmt.dateTime(latest.publishedAt)],
              [t('agents.overview.digest'), <Code key="d">{latest.digest.slice(0, 19)}…</Code>],
              [t('agents.overview.owner'), d.owner ?? '–'],
              [t('agents.overview.classification'), d.classification ?? '–'],
              [
                t('agents.overview.triggers'),
                d.triggers.length
                  ? d.triggers.map((tr, i) => (
                      <Badge key={i} tone="accent">
                        {tr.type}
                        {tr.detail ? `: ${tr.detail}` : ''}
                      </Badge>
                    ))
                  : '–',
              ],
              [
                t('agents.overview.approvers'),
                d.approverRoles.length ? d.approverRoles.join(', ') : '–',
              ],
            ]}
          />
        </Section>
        <Section title={t('agents.overview.runtime')}>
          <KeyValue
            items={[
              [t('agents.overview.runner'), <Code key="r">{d.runner ?? 'in-process'}</Code>],
              [
                t('agents.overview.toolbox'),
                d.toolbox ? <Code key="tb">{d.toolbox}</Code> : t('agents.overview.noToolbox'),
              ],
              [
                t('agents.overview.egress'),
                d.egress.length ? d.egress.join(', ') : t('agents.overview.noEgress'),
              ],
              ...Object.entries(d.budget).map(([k, v]): [string, string] => [
                t('agents.overview.budget', { key: k }),
                k === 'maxCostUsd' ? fmt.usd(v) : fmt.number(v),
              ]),
            ]}
          />
        </Section>
      </div>
      {d.agents.map((spec) => (
        <Section key={spec.id} title={t('agents.overview.agent', { id: spec.id })}>
          <KeyValue
            items={[
              [t('agents.overview.provider'), `${spec.provider} / ${spec.model}`],
              ...(spec.toolbox
                ? [
                    [t('agents.overview.toolbox'), <Code key="tb">{spec.toolbox}</Code>] as [
                      string,
                      ReactNode,
                    ],
                  ]
                : []),
              ...(spec.access
                ? [
                    [
                      t('agents.overview.access'),
                      <Badge key="acc" tone={spec.access === 'read-only' ? 'info' : 'warning'}>
                        {t(`agents.overview.accessValues.${spec.access}`)}
                      </Badge>,
                    ] as [string, ReactNode],
                  ]
                : []),
              [t('agents.overview.outputs'), spec.outputs.join(', ')],
            ]}
          />
          {spec.tools.length ? (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">{t('agents.overview.tools')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('agents.overview.tool')}</th>
                    <th scope="col">{t('agents.overview.args')}</th>
                    <th scope="col">{t('agents.overview.approval')}</th>
                  </tr>
                </thead>
                <tbody>
                  {spec.tools.map((tool) => (
                    <tr key={`${tool.server}/${tool.tool}`}>
                      <td className="mono">
                        {tool.server}/{tool.tool}
                        {tool.via ? (
                          <span className="muted">
                            {' '}
                            {t('agents.overview.via', { profile: tool.via })}
                          </span>
                        ) : null}
                        {tool.maxCallsPerRun ? (
                          <span className="muted"> ≤{tool.maxCallsPerRun}×</span>
                        ) : null}
                      </td>
                      <td className="mono">{tool.args.join(', ') || '–'}</td>
                      <td>
                        {tool.approval ? (
                          <Badge tone="warning">{t('agents.overview.approvalRequired')}</Badge>
                        ) : (
                          <Badge>{t('agents.overview.approvalNone')}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{t('agents.overview.noTools')}</p>
          )}
        </Section>
      ))}
    </div>
  );
}
