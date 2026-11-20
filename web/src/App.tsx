import { CurrencyDisplayProvider } from './types/CurrencyDisplayContext';
import { TimeZoneProvider } from './utils/TimeZoneProvider';
import React from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAppConfig } from './types/config';
import { AuthGate } from './components/common/AuthGate';
import { RouteErrorPage } from './components/common/RouteErrorPage';
import { DemoNotice } from './components/common/DemoNotice';
import { ConfirmDialogHost, Toaster } from './components/feedback';
// Eager: it stands in for the shell while the shell's own download and the stored preferences are
// in flight. It reads the locale, so a language change re-renders it rather than recreating the router.
import { ShellLoading } from './components/common/ShellLoading';

import {
  AppLayout,
  UsageEventsPage,
  PricingPage,
  ProvidersPage,
  ApiKeysPage,
  DashboardPage,
  InsightsPage,
  TrendsPage,
  AgentPage,
  AuthorizePage,
  PlaygroundPage,
  ModelSquarePage,
  RoutingPage,
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
import { ThemeProvider, ThemeServerSync } from './theme/ThemeContext';
import { I18nProvider } from './i18n';
import { TokenDisplayProvider } from './types/tokenDisplayContext';
import { useScrollSmoothing } from './hooks/useScrollSmoothing';
import { MotionPreferenceSync, MotionProvider } from './hooks/useReducedMotionPreference';
import { useConsoleFonts } from './hooks/useFonts';
import { DEFAULT_SWR_STALE_TIME_MS } from './api/queryKeys';
import { useEventSource } from './hooks/useEventSource';
import { consumeStandaloneRoute } from './utils/reloadRecovery';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30s SWR window delivers 0ms cached route/tab switches while background SSE
      // events (/api/events) push immediate invalidations on server-side mutations.
      staleTime: DEFAULT_SWR_STALE_TIME_MS,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <ThemeProvider>
        <ThemedShell />
      </ThemeProvider>
    </I18nProvider>
  </QueryClientProvider>
);

/** Renders nothing; it only switches the console-wide wheel and keyboard glide (`useScrollSmoothing`). */
const ScrollSmoothingSync: React.FC = () => {
  useScrollSmoothing();
  return null;
};

/** Renders nothing; it keeps the document painted in the chosen typefaces (`useConsoleFonts`). */
const FontSync: React.FC = () => {
  useConsoleFonts();
  return null;
};

/** Renders nothing; maintains the authenticated tab-wide '/api/events' SSE reconciliation stream. */
const StateEventsSync: React.FC = () => {
  useEventSource('/api/events', { isEnabled: !getAppConfig().demo });
  return null;
};

/**
 * Restores the last whitelisted console route when an installed standalone PWA restarts at
 * `start_url` (`./`); regular browser tabs always land on `/dashboard` as before.
 */
const ConsoleIndexRedirect: React.FC = () => {
  const [target] = React.useState(() => consumeStandaloneRoute() ?? '/dashboard');
  return <Navigate to={target} replace />;
};

const ThemedShell: React.FC = () => (
  <MotionProvider>
    <MotionPreferenceSync />
    <ScrollSmoothingSync />
    <FontSync />
    <DemoNotice />
    <Toaster />
    <ConfirmDialogHost />
    <TokenDisplayProvider>
      <CurrencyDisplayProvider>
        <AppRoutes />
      </CurrencyDisplayProvider>
    </TokenDisplayProvider>
  </MotionProvider>
);

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
        { index: true, element: <ConsoleIndexRedirect /> },
        { path: 'dashboard', element: <DashboardPage /> },
        { path: 'insights', element: <InsightsPage /> },
        { path: 'trends', element: <TrendsPage /> },
        { path: 'playground', element: <PlaygroundPage /> },
        { path: 'agent', element: <AgentPage /> },
        { path: 'model-square', element: <ModelSquarePage /> },
        { path: 'ai-providers', element: <ProvidersPage /> },
        { path: 'api-keys', element: <ApiKeysPage /> },
        { path: 'routing', element: <RoutingPage /> },
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
    }, {
      // The authorization screen stands outside the console's shell: see AuthorizePage.
      element: <React.Suspense fallback={<ShellLoading />}><Outlet /></React.Suspense>,
      errorElement: <RouteErrorPage />,
      children: [
        { path: 'authorize/:id', element: <AuthorizePage /> },
      ],
    }],
    { basename: config.basePath || undefined },
  ), [config.basePath]);

  return (
    <AuthGate>
      {/* The deployment's copy of the theme can only be read and written with a session. Signed
          out, a theme change stays in this browser marked dirty, and this pushes it on sign-in;
          mounted outside the gate it sent the write anyway and reported the refusal in a toast. */}
      <ThemeServerSync />
      <StateEventsSync />
      <TimeZoneProvider fallback={<ShellLoading />}><RouterProvider router={router} /></TimeZoneProvider>
    </AuthGate>
  );
};
