import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { settingsQuery, versionQuery } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import {
  Badge,
  CopyButton,
  ErrorState,
  KeyValue,
  Loading,
  PageHeader,
  Section,
  SelectField,
  TextField,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { PreferencesControls } from '../../layout/PreferencesControls';

export interface BedrockForm {
  name: string;
  region: string;
  endpoint: string;
  proxyUrl: string;
  clearance: string;
}

/** One `OAX_PROVIDERS` entry for AWS Bedrock (VPC interface endpoint and HTTPS proxy optional). */
export function bedrockSnippet(f: BedrockForm): string {
  const entry: Record<string, string> = {
    name: f.name || 'bedrock',
    kind: 'bedrock',
    region: f.region || 'eu-central-1',
  };
  if (f.endpoint) entry.endpoint = f.endpoint;
  if (f.proxyUrl) entry.proxyUrl = f.proxyUrl;
  if (f.clearance) entry.clearance = f.clearance;
  return JSON.stringify([entry], null, 2);
}

export function isHttpsUrl(value: string): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function SettingsPage() {
  const { t } = useI18n();
  useDocumentTitle(t('settings.title'));
  const settings = useQuery(settingsQuery);
  const version = useQuery(versionQuery);
  const [form, setForm] = useState<BedrockForm>({
    name: 'bedrock',
    region: 'eu-central-1',
    endpoint: '',
    proxyUrl: '',
    clearance: 'confidential',
  });
  const snippet = bedrockSnippet(form);
  return (
    <div className="page">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      <Section title={t('settings.preferences')}>
        <PreferencesControls />
      </Section>
      {settings.isPending ? (
        <Loading />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="grid-2">
          <Section title={t('settings.providers')}>
            <p className="muted">{t('settings.providersText')}</p>
            <ul className="list">
              {settings.data.providers.map((p) => (
                <li key={p.name} className="list-row">
                  <span className="list-main">
                    <span className="strong">{p.name}</span>{' '}
                    <span className="mono muted">{p.kind}</span>
                  </span>
                  {p.clearance ? <Badge>{t(`classification.${p.clearance}`)}</Badge> : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title={t('settings.runners')}>
            <p className="muted">{t('settings.runnersText')}</p>
            <ul className="list">
              {settings.data.runners.map((r) => (
                <li key={r.kind} className="list-row">
                  <span className="list-main mono">{r.kind}</span>
                  <Badge tone={r.available ? 'success' : 'neutral'}>
                    {r.available ? t('dashboard.available') : t('dashboard.planned')}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
          <Section title={t('settings.auth')}>
            <KeyValue
              items={[
                [t('settings.authLocal'), <Enabled key="l" on={settings.data.auth.local} />],
                [t('settings.authLdap'), <Enabled key="d" on={settings.data.auth.ldap} />],
                [t('settings.authOidc'), <Enabled key="o" on={settings.data.auth.oidc} />],
                [t('settings.version'), version.data?.version ?? settings.data.version],
              ]}
            />
          </Section>
        </div>
      )}
      <Section title={t('settings.bedrock.title')}>
        <p className="muted">{t('settings.bedrock.text')}</p>
        <div className="form-row">
          <TextField
            label={t('settings.bedrock.name')}
            className="input mono"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label={t('settings.bedrock.region')}
            className="input mono"
            value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })}
          />
          <SelectField
            label={t('settings.bedrock.clearance')}
            value={form.clearance}
            onChange={(e) => setForm({ ...form, clearance: e.target.value })}
          >
            {(['public', 'internal', 'confidential', 'restricted'] as const).map((c) => (
              <option key={c} value={c}>
                {t(`classification.${c}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="form-row">
          <TextField
            label={t('settings.bedrock.endpoint')}
            hint={t('settings.bedrock.endpointHint')}
            className="input mono"
            placeholder="https://vpce-0abc123.bedrock-runtime.eu-central-1.vpce.amazonaws.com"
            value={form.endpoint}
            error={isHttpsUrl(form.endpoint) ? null : t('settings.bedrock.httpsOnly')}
            onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
          />
          <TextField
            label={t('settings.bedrock.proxy')}
            hint={t('settings.bedrock.proxyHint')}
            className="input mono"
            placeholder="http://proxy.internal:3128"
            value={form.proxyUrl}
            onChange={(e) => setForm({ ...form, proxyUrl: e.target.value })}
          />
        </div>
        <div className="preview-bar">
          <span className="strong">OAX_PROVIDERS</span>
          <CopyButton value={snippet} label={t('settings.bedrock.copy')} />
        </div>
        <pre className="code-block" tabIndex={0}>
          {snippet}
        </pre>
        <p className="hint">
          <Icon name="info" size={14} /> {t('settings.bedrock.credentials')}
        </p>
      </Section>
    </div>
  );
}

function Enabled({ on }: { on: boolean }) {
  const t = useI18n().t;
  return (
    <Badge tone={on ? 'success' : 'neutral'}>
      {on ? t('common.enabled') : t('common.disabled')}
    </Badge>
  );
}
