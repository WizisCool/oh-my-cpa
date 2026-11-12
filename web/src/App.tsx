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
import type { RouteLoadingBody, RouteLoadingHandle } from './components/common/PageLoading';
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

/**
 * The frame a route draws while its module downloads: the shape of its loaded body, so the page that
 * replaces it lands in place. A route that names none is a list. Read by `AppLayout`.
 */
function loadingAs(loading: RouteLoadingBody): RouteLoadingHandle {
  return { loading };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
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
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard', element: <DashboardPage />, handle: loadingAs('dashboard') },
        { path: 'insights', element: <InsightsPage />, handle: loadingAs('panels') },
        { path: 'playground', element: <PlaygroundPage />, handle: loadingAs('workspace') },
        { path: 'agent', element: <AgentPage />, handle: loadingAs('workspace') },
        { path: 'model-square', element: <ModelSquarePage /> },
        { path: 'ai-providers', element: <ProvidersPage /> },
        { path: 'api-keys', element: <ApiKeysPage /> },
        { path: 'routing', element: <RoutingPage />, handle: loadingAs('panels') },
        { path: 'oauth-management', element: <OAuthManagementPage /> },
        { path: 'auth-files', element: <LegacyOAuthManagementRedirect from="/auth-files" /> },
        { path: 'oauth', element: <LegacyOAuthManagementRedirect from="/oauth" /> },
        { path: 'quota', element: <LegacyOAuthManagementRedirect from="/quota" /> },
        { path: 'logs', element: <LogsPage />, handle: loadingAs('table') },
        { path: 'audit', element: <AuditPage />, handle: loadingAs('table') },
        { path: 'usage/events', element: <UsageEventsPage />, handle: loadingAs('table') },
        { path: 'pricing', element: <PricingPage />, handle: loadingAs('table') },
        { path: 'config', element: <ConfigPage />, handle: loadingAs('panels') },
        { path: 'omc-settings', element: <OmcSettingsPage />, handle: loadingAs('panels') },
        // One page under three addresses, so the store and the settings can be linked to
        // and listed in the navigation.
        { path: 'plugins', element: <PluginsPage /> },
        { path: 'plugins/store', element: <PluginsPage /> },
        { path: 'plugins/settings', element: <PluginsPage /> },
        { path: 'plugin-store', element: <Navigate to="/plugins/store" replace /> },
        { path: 'plugin-pages/:pluginId/:pageIndex', element: <PluginPageHost /> },
        { path: 'system', element: <SystemPage />, handle: loadingAs('panels') },
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
      <TimeZoneProvider fallback={<ShellLoading />}><RouterProvider router={router} /></TimeZoneProvider>
    </AuthGate>
  );
};
