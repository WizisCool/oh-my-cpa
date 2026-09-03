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
import { TriagePage } from './pages/TriagePage';
import { AllResourcesPage } from './pages/AllResourcesPage';
import { UsageEventsPage } from './pages/UsageEventsPage';
import { InstanceStatusPage } from './pages/InstanceStatusPage';
import { AuthGate } from './components/common/AuthGate';
import { DashboardPage } from './pages/DashboardPage';
import { LogsPage } from './pages/LogsPage';
import { ConfigPage } from './pages/ConfigPage';
import { AuthFilesPage } from './pages/AuthFilesPage';
import { CapabilityPlaceholderPage } from './pages/CapabilityPlaceholderPage';
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
        { path: 'quick-start', element: <CapabilityPlaceholderPage navKey="quick_start" capability="quick-start" /> },
        { path: 'ai-providers', element: <CapabilityPlaceholderPage navKey="providers" capability="ai-providers" /> },
        { path: 'auth-files', element: <AuthFilesPage /> },
        { path: 'oauth', element: <CapabilityPlaceholderPage navKey="oauth" capability="oauth" /> },
        { path: 'quota', element: <CapabilityPlaceholderPage navKey="quota" capability="quota" /> },
        { path: 'logs', element: <LogsPage /> },
        { path: 'usage/events', element: <UsageEventsPage /> },
        { path: 'config', element: <ConfigPage /> },
        { path: 'plugins', element: <CapabilityPlaceholderPage navKey="plugins" capability="plugins" /> },
        { path: 'plugin-store', element: <CapabilityPlaceholderPage navKey="plugin_store" capability="plugin-store" /> },
        { path: 'system', element: <CapabilityPlaceholderPage navKey="system" capability="system" /> },
        { path: 'resources/triage', element: <TriagePage /> },
        { path: 'resources/all', element: <AllResourcesPage /> },
        { path: 'instances', element: <InstanceStatusPage /> },
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
