import { useState } from 'react';
import { Button, Code } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import {
  PROFILE_NAME,
  TOOL_NAME,
  accessProblems,
  readToolAccess,
  writeToolAccess,
  type ToolAccess,
} from './profiles';

/** Compact, read-only view for a connection card. */
export function ToolAccessSummary({ config }: { config: Record<string, unknown> }) {
  const { t } = useI18n();
  const { tools, profiles } = readToolAccess(config);
  const toolNames = Object.keys(tools);
  if (toolNames.length === 0 && Object.keys(profiles).length === 0) return null;
  return (
    <details>
      <summary>{t('connections.profiles.summary', { count: toolNames.length })}</summary>
      <table className="table">
        <caption className="sr-only">{t('connections.profiles.tools')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('connections.profiles.tool')}</th>
            <th scope="col">{t('connections.profiles.access')}</th>
          </tr>
        </thead>
        <tbody>
          {toolNames.map((n) => (
            <tr key={n}>
              <td className="mono">{n}</td>
              <td>
                {t(
                  tools[n] === 'read' ? 'connections.profiles.read' : 'connections.profiles.write',
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="stack">
        {Object.entries(profiles).map(([name, members]) => (
          <li key={name}>
            <Code>{name}</Code> <span className="muted">{members.join(', ')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Editor for tool classes and profiles; changes the JSON config through `onChange`. */
export function ToolProfilesEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const access = readToolAccess(config);
  const [tool, setTool] = useState('');
  const [profile, setProfile] = useState('');
  const set = (next: typeof access) => onChange(writeToolAccess(config, next));
  const problems = accessProblems(access);
  const toolOk = TOOL_NAME.test(tool) && !(tool in access.tools);
  const profileOk = PROFILE_NAME.test(profile) && !(profile in access.profiles);
  return (
    <fieldset className="stack">
      <legend className="strong">{t('connections.profiles.title')}</legend>
      <p className="muted">{t('connections.profiles.hint')}</p>
      <table className="table">
        <caption className="sr-only">{t('connections.profiles.tools')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('connections.profiles.tool')}</th>
            <th scope="col">{t('connections.profiles.access')}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {Object.entries(access.tools).map(([name, a]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td>
                <select
                  className="input select"
                  aria-label={t('connections.profiles.accessOf', { tool: name })}
                  value={a}
                  onChange={(e) =>
                    set({
                      ...access,
                      tools: { ...access.tools, [name]: e.target.value as ToolAccess },
                    })
                  }
                >
                  <option value="read">{t('connections.profiles.read')}</option>
                  <option value="write">{t('connections.profiles.write')}</option>
                </select>
              </td>
              <td>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('connections.profiles.removeTool', { tool: name })}
                  onClick={() => {
                    const { [name]: _gone, ...tools } = access.tools;
                    set({
                      tools,
                      profiles: Object.fromEntries(
                        Object.entries(access.profiles).map(([p, m]) => [
                          p,
                          m.filter((x) => x !== name),
                        ]),
                      ),
                    });
                  }}
                >
                  {t('common.delete')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cluster">
        <input
          className="input"
          aria-label={t('connections.profiles.newTool')}
          placeholder="get_issue"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
        />
        <Button
          size="sm"
          disabled={!toolOk}
          onClick={() => {
            set({ ...access, tools: { ...access.tools, [tool]: 'write' } });
            setTool('');
          }}
        >
          {t('connections.profiles.addTool')}
        </Button>
      </div>
      {Object.entries(access.profiles).map(([name, members]) => (
        <fieldset key={name} className="stack">
          <legend>
            <Code>{name}</Code>
          </legend>
          <div className="cluster">
            {Object.keys(access.tools).map((n) => (
              <label key={n} className="cluster">
                <input
                  type="checkbox"
                  checked={members.includes(n)}
                  onChange={(e) =>
                    set({
                      ...access,
                      profiles: {
                        ...access.profiles,
                        [name]: e.target.checked ? [...members, n] : members.filter((x) => x !== n),
                      },
                    })
                  }
                />
                <span className="mono">{n}</span>
              </label>
            ))}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('connections.profiles.removeProfile', { profile: name })}
              onClick={() => {
                const { [name]: _gone, ...profiles } = access.profiles;
                set({ ...access, profiles });
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="cluster">
        <input
          className="input"
          aria-label={t('connections.profiles.newProfile')}
          placeholder="read"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
        />
        <Button
          size="sm"
          disabled={!profileOk}
          onClick={() => {
            set({ ...access, profiles: { ...access.profiles, [profile]: [] } });
            setProfile('');
          }}
        >
          {t('connections.profiles.addProfile')}
        </Button>
      </div>
      {problems.length ? (
        <p className="error-text" role="alert">
          {t('connections.profiles.problems', { items: problems.join('; ') })}
        </p>
      ) : null}
    </fieldset>
  );
}
