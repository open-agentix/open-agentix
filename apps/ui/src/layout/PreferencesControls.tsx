import { useId } from 'react';
import { LOCALES, isLocale, useI18n } from '../i18n/i18n';
import { THEMES, useTheme, type Theme } from '../theme/theme';
import { Icon } from '../components/Icon';

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const;

export function PreferencesControls() {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const langId = useId();
  return (
    <div className="prefs">
      <div className="prefs-row">
        <label htmlFor={langId} className="prefs-label">
          <Icon name="globe" size={16} />
          <span className="sr-only">{t('prefs.language')}</span>
        </label>
        <select
          id={langId}
          className="input select input-sm"
          value={locale}
          onChange={(e) => isLocale(e.target.value) && void setLocale(e.target.value)}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`prefs.locales.${l}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="segmented" role="radiogroup" aria-label={t('prefs.theme')}>
        {THEMES.map((th: Theme) => (
          <button
            key={th}
            type="button"
            role="radio"
            aria-checked={theme === th}
            className="segment"
            onClick={() => setTheme(th)}
            title={t(`prefs.themes.${th}`)}
          >
            <Icon name={THEME_ICON[th]} size={16} />
            <span className="sr-only">{t(`prefs.themes.${th}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
