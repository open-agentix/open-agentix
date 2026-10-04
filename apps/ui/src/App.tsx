import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ToastProvider } from './components/toast';
import { I18nProvider, type Locale } from './i18n/i18n';
import type { AppRouter } from './router';
import { ThemeProvider } from './theme/theme';

export function App({
  router,
  queryClient,
  locale,
}: {
  router: AppRouter;
  queryClient: QueryClient;
  locale: Locale;
}) {
  return (
    <I18nProvider initialLocale={locale}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
