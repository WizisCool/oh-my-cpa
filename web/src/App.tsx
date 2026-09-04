import React from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAppConfig } from './types/config';
import { createThemeConfig, type ThemeMode } from './theme/themeConfig';
import { AppLayout } from './components/common/AppLayout';
import { AuthGate } from './components/common/AuthGate';

const UsageEventsPage = React.lazy(() => import('./pages/UsageEventsPage').then(m => ({ default: m.UsageEventsPage })));
const ProvidersPage = React.lazy(() => import('./pages/ProvidersPage').then(m => ({ default: m.ProvidersPage })));
const DashboardPage = React.lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const QuickStartPage = React.lazy(() => import('./pages/QuickStartPage').then(m => ({ default: m.QuickStartPage })));
const LogsPage = React.lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })));
const ConfigPage = React.lazy(() => import('./pages/ConfigPage').then(m => ({ default: m.ConfigPage })));
const AuthFilesPage = React.lazy(() => import('./pages/AuthFilesPage').then(m => ({ default: m.AuthFilesPage })));
const OAuthPage = React.lazy(() => import('./pages/OAuthPage').then(m => ({ default: m.OAuthPage })));
const QuotaPage = React.lazy(() => import('./pages/QuotaPage').then(m => ({ default: m.QuotaPage })));
const SystemPage = React.lazy(() => import('./pages/SystemPage').then(m => ({ default: m.SystemPage })));
const PluginsPage = React.lazy(() => import('./pages/PluginsPage').then(m => ({ default: m.PluginsPage })));
const PluginStorePage = React.lazy(() => import('./pages/PluginStorePage').then(m => ({ default: m.PluginStorePage })));
import { ThemeContext } from './theme/ThemeContext';
import { I18nProvider, useI18n } from './i18n';

// Configure TanStack Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

interface ThemeContextValue {
  themeMode: ThemeMode;
  toggleTheme: () => void;
}

export const App: React.FC = () => {
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark';
    return window.localStorage.getItem('omc-theme') === 'light' ? 'light' : 'dark';
  });

  React.useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem('omc-theme', themeMode);
  }, [themeMode]);

  const toggleTheme = React.useCallback(() => {
    setThemeMode((mode) => mode === 'dark' ? 'light' : 'dark');
  }, []);

  const themeContextValue = React.useMemo<ThemeContextValue>(
    () => ({ themeMode, toggleTheme }),
    [themeMode, toggleTheme],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemedProviders themeContextValue={themeContextValue} themeMode={themeMode} />
      </I18nProvider>
    </QueryClientProvider>
  );
};

// Sits below I18nProvider so the antd locale follows the app language.
const ThemedProviders: React.FC<{ themeContextValue: ThemeContextValue; themeMode: ThemeMode }> = ({
  themeContextValue,
  themeMode,
}) => {
  const { lang } = useI18n();
  return (
    <ConfigProvider locale={lang === 'zh' ? zhCN : enUS} theme={createThemeConfig(themeMode)}>
      <AntdApp>
        <ThemeContext.Provider value={themeContextValue}>
          <AppRoutes />
        </ThemeContext.Provider>
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
        { path: 'auth-files', element: <AuthFilesPage /> },
        { path: 'oauth', element: <OAuthPage /> },
        { path: 'quota', element: <QuotaPage /> },
        { path: 'logs', element: <LogsPage /> },
        { path: 'usage/events', element: <UsageEventsPage /> },
        { path: 'config', element: <ConfigPage /> },
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
