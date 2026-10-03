import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { detectLocale, loadLocale } from './i18n/i18n';
import { createQueryClient } from './lib/queryClient';
import { createAppRouter } from './router';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/app.css';
import { applyTheme, storedTheme } from './theme/theme';

applyTheme(storedTheme());
const locale = detectLocale();
document.documentElement.lang = locale;
await loadLocale(locale);

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} locale={locale} />
  </StrictMode>,
);
