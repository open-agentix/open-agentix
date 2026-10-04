import { useQuery } from '@tanstack/react-query';
import { agentVersionQuery } from '../../api/queries';
import type { Agent, AgentVersion } from '../../api/types';
import { ErrorState, Loading, Section, SelectField } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { DiffView } from './DiffView';

const DRAFT = 'draft';

function useSource(agent: Agent, ref: string) {
  const query = useQuery({ ...agentVersionQuery(agent.id, ref), enabled: ref !== DRAFT && !!ref });
  if (ref === DRAFT) return { source: agent.draftSource, pending: false, error: null };
  return { source: query.data?.source ?? null, pending: query.isPending, error: query.error };
}

export function DiffTab({
  agent,
  versions,
  from,
  to,
  onChange,
}: {
  agent: Agent;
  versions: AgentVersion[];
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string, to: string) => void;
}) {
  const t = useT();
  const fromRef = from ?? agent.latestVersion ?? DRAFT;
  const toRef = to ?? DRAFT;
  const before = useSource(agent, fromRef);
  const after = useSource(agent, toRef);
  const options = [
    { value: DRAFT, label: t('agents.diff.draft') },
    ...versions.map((v) => ({ value: v.version, label: `v${v.version}` })),
  ];
  return (
    <Section>
      <div className="form-row">
        <SelectField
          label={t('agents.diff.from')}
          value={fromRef}
          onChange={(e) => onChange(e.target.value, toRef)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('agents.diff.to')}
          value={toRef}
          onChange={(e) => onChange(fromRef, e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
      {before.error || after.error ? (
        <ErrorState error={before.error ?? after.error} />
      ) : before.source === null || after.source === null ? (
        <Loading />
      ) : (
        <DiffView
          before={before.source}
          after={after.source}
          label={`${fromRef === DRAFT ? t('agents.diff.draft') : `v${fromRef}`} → ${
            toRef === DRAFT ? t('agents.diff.draft') : `v${toRef}`
          }`}
        />
      )}
    </Section>
  );
}
