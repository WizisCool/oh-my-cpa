import React from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import msMY from 'antd/locale/ms_MY';
import zhCN from 'antd/locale/zh_CN';
import zhTW from 'antd/locale/zh_TW';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAppConfig } from './types/config';
import { createThemeConfig } from './theme/themeConfig';
import { AppLayout } from './components/common/AppLayout';
import { AuthGate } from './components/common/AuthGate';
import { DemoNotice } from './components/common/DemoNotice';

const UsageEventsPage = React.lazy(() => import('./pages/UsageEventsPage').then(m => ({ default: m.UsageEventsPage })));
const PricingPage = React.lazy(() => import('./pages/pricing/PricingPage').then(m => ({ default: m.PricingPage })));
const ProvidersPage = React.lazy(() => import('./pages/ProvidersPage').then(m => ({ default: m.ProvidersPage })));
const ApiKeysPage = React.lazy(() => import('./pages/ApiKeysPage').then(m => ({ default: m.ApiKeysPage })));
const DashboardPage = React.lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const QuickStartPage = React.lazy(() => import('./pages/QuickStartPage').then(m => ({ default: m.QuickStartPage })));
const LogsPage = React.lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })));
const ConfigPage = React.lazy(() => import('./pages/ConfigPage').then(m => ({ default: m.ConfigPage })));
const OAuthManagementPage = React.lazy(() => import('./pages/oauthManagement/OAuthManagementPage').then(m => ({ default: m.OAuthManagementPage })));
const LegacyOAuthManagementRedirect = React.lazy(() => import('./pages/LegacyOAuthManagementRedirect').then(m => ({ default: m.LegacyOAuthManagementRedirect })));
const SystemPage = React.lazy(() => import('./pages/SystemPage').then(m => ({ default: m.SystemPage })));
const PluginsPage = React.lazy(() => import('./pages/PluginsPage').then(m => ({ default: m.PluginsPage })));
const PluginStorePage = React.lazy(() => import('./pages/PluginStorePage').then(m => ({ default: m.PluginStorePage })));
// Lazy like every other route, and not only for consistency: the palette editor pulls in Ant Design's
// colour picker, which is a large dependency for a page an operator visits once. Loading it eagerly put
// that cost into the first paint of the console - and into the sign-in screen, which renders this
// application's shell.
const OmcSettingsPage = React.lazy(() => import('./pages/OmcSettingsPage').then(m => ({ default: m.OmcSettingsPage })));
import { ThemeProvider, ThemeServerSync, useTheme } from './theme/ThemeContext';
import { I18nProvider, useI18n } from './i18n';
import { TokenDisplayProvider } from './types/tokenDisplayContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const ANTD_LOCALES = {
  zh: zhCN,
  'zh-Hant': zhTW,
  en: enUS,
  ms: msMY,
} as const;

export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <ThemeProvider>
        <ThemedShell />
      </ThemeProvider>
    </I18nProvider>
  </QueryClientProvider>
);

/**
 * Sits below both the theme and locale providers, because Ant Design's tokens and locale are both
 * projections: the theme decides every colour, the language decides date and number formats.
 *
 * `ThemeServerSync` is rendered here rather than inside `ThemeProvider` for one reason - it reports
 * a refused save through Ant Design's message API, and `App` is the first component that provides
 * one. The theme itself does not wait for it: the console is painted from the browser's own stored
 * preference in the first frame, and the deployment's copy is reconciled afterwards.
 */
const ThemedShell: React.FC = () => {
  const { lang } = useI18n();
  const { theme } = useTheme();
  const antdTheme = React.useMemo(() => createThemeConfig(theme), [theme]);
  return (
    <ConfigProvider locale={ANTD_LOCALES[lang]} theme={antdTheme}>
      <AntdApp>
        <ThemeServerSync />
        <DemoNotice />
        <TokenDisplayProvider>
          <AppRoutes />
        </TokenDisplayProvider>
      </AntdApp>
    </ConfigProvider>
  );
};

const AppRoutes: React.FC = () => {
  const config = getAppConfig();
  const router = React.useMemo(() => createBrowserRouter(
    [{
      path: '/',
      element: <AppLayout />,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard', element: <DashboardPage /> },
        { path: 'quick-start', element: <QuickStartPage /> },
        { path: 'ai-providers', element: <ProvidersPage /> },
        { path: 'api-keys', element: <ApiKeysPage /> },
        { path: 'oauth-management', element: <OAuthManagementPage /> },
        { path: 'auth-files', element: <LegacyOAuthManagementRedirect from="/auth-files" /> },
        { path: 'oauth', element: <LegacyOAuthManagementRedirect from="/oauth" /> },
        { path: 'quota', element: <LegacyOAuthManagementRedirect from="/quota" /> },
        { path: 'logs', element: <LogsPage /> },
        { path: 'usage/events', element: <UsageEventsPage /> },
        { path: 'pricing', element: <PricingPage /> },
        { path: 'config', element: <ConfigPage /> },
        { path: 'omc-settings', element: <OmcSettingsPage /> },
        { path: 'plugins', element: <PluginsPage /> },
        { path: 'plugin-store', element: <PluginStorePage /> },
        { path: 'system', element: <SystemPage /> },
        { path: '*', element: <Navigate to="/dashboard" replace /> },
      ],
    }],
    { basename: config.basePath || undefined },
  ), [config.basePath]);

  return (
    <AuthGate>
      <RouterProvider router={router} />
    </AuthGate>
  );
};
