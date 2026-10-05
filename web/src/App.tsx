import { TimeZoneProvider } from './utils/TimeZoneProvider';
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
import { AuthGate } from './components/common/AuthGate';
import { RouteErrorPage } from './components/common/RouteErrorPage';
import { DemoNotice } from './components/common/DemoNotice';
// Eager: it stands in for the shell while the shell's own download and the stored preferences are
// in flight. It reads the locale, so a language change re-renders it rather than recreating the router.
import { ShellLoading } from './components/common/ShellLoading';

import {
  UsageEventsPage,
  PricingPage,
  ProvidersPage,
  ApiKeysPage,
  DashboardPage,
  AgentPage,
  PlaygroundPage,
  ModelSquarePage,
  LogsPage,
  AuditPage,
  ConfigPage,
  OAuthManagementPage,
  LegacyOAuthManagementRedirect,
  SystemPage,
  PluginsPage,
  PluginPageHost,
  OmcSettingsPage,
} from './routePages';
import { ThemeProvider, ThemeServerSync, useTheme } from './theme/ThemeContext';
import { I18nProvider, useI18n } from './i18n';
import { TokenDisplayProvider } from './types/tokenDisplayContext';
import { useScrollSmoothing } from './hooks/useScrollSmoothing';

// The recovery boundary stays eager even when the authenticated shell cannot be downloaded.
const AppLayout = React.lazy(() => import('./components/common/AppLayout').then(module => ({ default: module.AppLayout })));

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
 * a refused save through a toast (`useToast`), and `App` is the first component that provides
 * one. The theme itself does not wait for it: the console is painted from the browser's own stored
 * preference in the first frame, and the deployment's copy is reconciled afterwards.
 */
/**
 * Toasts (`useToast`) open at the top centre, where the eye already is after a click in the page
 * header or a table, and never stack into a collapsed pile: a report with per-target reasons has to
 * stay readable beside the acknowledgement that followed it.
 */
const TOAST_CONFIG = { placement: 'top', stack: false } as const;

/** Renders nothing; it only switches the console-wide wheel and keyboard glide (`useScrollSmoothing`). */
const ScrollSmoothingSync: React.FC = () => {
  useScrollSmoothing();
  return null;
};

const ThemedShell: React.FC = () => {
  const { lang } = useI18n();
  const { theme } = useTheme();
  const antdTheme = React.useMemo(() => createThemeConfig(theme), [theme]);
  return (
    <ConfigProvider locale={ANTD_LOCALES[lang]} theme={antdTheme}>
      <AntdApp notification={TOAST_CONFIG}>
        <ThemeServerSync />
        <ScrollSmoothingSync />
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
      element: (
        <React.Suspense fallback={<ShellLoading />}>
          <AppLayout />
        </React.Suspense>
      ),
      errorElement: <RouteErrorPage />,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard', element: <DashboardPage /> },
        { path: 'playground', element: <PlaygroundPage /> },
        { path: 'agent', element: <AgentPage /> },
        { path: 'model-square', element: <ModelSquarePage /> },
        { path: 'ai-providers', element: <ProvidersPage /> },
        { path: 'api-keys', element: <ApiKeysPage /> },
        { path: 'oauth-management', element: <OAuthManagementPage /> },
        { path: 'auth-files', element: <LegacyOAuthManagementRedirect from="/auth-files" /> },
        { path: 'oauth', element: <LegacyOAuthManagementRedirect from="/oauth" /> },
        { path: 'quota', element: <LegacyOAuthManagementRedirect from="/quota" /> },
        { path: 'logs', element: <LogsPage /> },
        { path: 'audit', element: <AuditPage /> },
        { path: 'usage/events', element: <UsageEventsPage /> },
        { path: 'pricing', element: <PricingPage /> },
        { path: 'config', element: <ConfigPage /> },
        { path: 'omc-settings', element: <OmcSettingsPage /> },
        // One page under three addresses, so the store and the settings can be linked to
        // and listed in the navigation.
        { path: 'plugins', element: <PluginsPage /> },
        { path: 'plugins/store', element: <PluginsPage /> },
        { path: 'plugins/settings', element: <PluginsPage /> },
        { path: 'plugin-store', element: <Navigate to="/plugins/store" replace /> },
        { path: 'plugin-pages/:pluginId/:pageIndex', element: <PluginPageHost /> },
        { path: 'system', element: <SystemPage /> },
        { path: '*', element: <Navigate to="/dashboard" replace /> },
      ],
    }],
    { basename: config.basePath || undefined },
  ), [config.basePath]);

  return (
    <AuthGate>
      <TimeZoneProvider fallback={<ShellLoading />}><RouterProvider router={router} /></TimeZoneProvider>
    </AuthGate>
  );
};
