import React from 'react';
import { createRouteLoader } from './utils/routeLoader';

const loadUsageEventsPage = createRouteLoader(() => import('./pages/UsageEventsPage').then(module => ({ default: module.UsageEventsPage })));
export const UsageEventsPage = React.lazy(loadUsageEventsPage);

const loadPricingPage = createRouteLoader(() => import('./pages/pricing/PricingPage').then(module => ({ default: module.PricingPage })));
export const PricingPage = React.lazy(loadPricingPage);

const loadProvidersPage = createRouteLoader(() => import('./pages/ProvidersPage').then(module => ({ default: module.ProvidersPage })));
export const ProvidersPage = React.lazy(loadProvidersPage);

const loadApiKeysPage = createRouteLoader(() => import('./pages/ApiKeysPage').then(module => ({ default: module.ApiKeysPage })));
export const ApiKeysPage = React.lazy(loadApiKeysPage);

const loadDashboardPage = createRouteLoader(() => import('./pages/DashboardPage').then(module => ({ default: module.DashboardPage })));
export const DashboardPage = React.lazy(loadDashboardPage);

const loadAgentPage = createRouteLoader(() => import('./pages/agent/AgentPage').then(module => ({ default: module.AgentPage })));
export const AgentPage = React.lazy(loadAgentPage);

const loadPlaygroundPage = createRouteLoader(() => import('./pages/playground/PlaygroundPage').then(module => ({ default: module.PlaygroundPage })));
export const PlaygroundPage = React.lazy(loadPlaygroundPage);

const loadQuickStartPage = createRouteLoader(() => import('./pages/QuickStartPage').then(module => ({ default: module.QuickStartPage })));
export const QuickStartPage = React.lazy(loadQuickStartPage);

const loadLogsPage = createRouteLoader(() => import('./pages/LogsPage').then(module => ({ default: module.LogsPage })));
export const LogsPage = React.lazy(loadLogsPage);

const loadAuditPage = createRouteLoader(() => import('./pages/AuditPage').then(module => ({ default: module.AuditPage })));
export const AuditPage = React.lazy(loadAuditPage);

const loadConfigPage = createRouteLoader(() => import('./pages/ConfigPage').then(module => ({ default: module.ConfigPage })));
export const ConfigPage = React.lazy(loadConfigPage);

const loadOAuthManagementPage = createRouteLoader(() => import('./pages/oauthManagement/OAuthManagementPage').then(module => ({ default: module.OAuthManagementPage })));
export const OAuthManagementPage = React.lazy(loadOAuthManagementPage);

const loadLegacyOAuthManagementRedirect = createRouteLoader(() => import('./pages/LegacyOAuthManagementRedirect').then(module => ({ default: module.LegacyOAuthManagementRedirect })));
export const LegacyOAuthManagementRedirect = React.lazy(loadLegacyOAuthManagementRedirect);

const loadSystemPage = createRouteLoader(() => import('./pages/SystemPage').then(module => ({ default: module.SystemPage })));
export const SystemPage = React.lazy(loadSystemPage);

const loadPluginsPage = createRouteLoader(() => import('./pages/PluginsPage').then(module => ({ default: module.PluginsPage })));
export const PluginsPage = React.lazy(loadPluginsPage);

const loadOmcSettingsPage = createRouteLoader(() => import('./pages/OmcSettingsPage').then(module => ({ default: module.OmcSettingsPage })));
export const OmcSettingsPage = React.lazy(loadOmcSettingsPage);

const ROUTE_LOADERS: Record<string, () => Promise<unknown>> = {
  '/usage/events': loadUsageEventsPage,
  '/pricing': loadPricingPage,
  '/ai-providers': loadProvidersPage,
  '/api-keys': loadApiKeysPage,
  '/dashboard': loadDashboardPage,
  '/agent': loadAgentPage,
  '/playground': loadPlaygroundPage,
  '/quick-start': loadQuickStartPage,
  '/logs': loadLogsPage,
  '/audit': loadAuditPage,
  '/config': loadConfigPage,
  '/oauth-management': loadOAuthManagementPage,
  '/auth-files': loadLegacyOAuthManagementRedirect,
  '/system': loadSystemPage,
  '/plugins': loadPluginsPage,
  '/omc-settings': loadOmcSettingsPage,
};

export function preloadRoute(path: string): void {
  // Code only: intent must not send authenticated reads or mount a page's effects.
  const loadRoute = ROUTE_LOADERS[path];
  if (loadRoute) void loadRoute().catch(() => undefined);
}
