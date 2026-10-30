import React from 'react';
import { createRouteLoader, lazyRoute } from './utils/routeLoader';

// Selection is shared by intent preloads and navigation without repeating it in every entry import.
function createPageLoader<Module, Name extends keyof Module>(importModule: () => Promise<Module>, name: Name) {
  return createRouteLoader(async () => ({ default: (await importModule())[name] }));
}

export const loadUsageEventsPage = createPageLoader(() => import('./pages/UsageEventsPage'), 'UsageEventsPage');
export const UsageEventsPage = lazyRoute(loadUsageEventsPage);

export const loadPricingPage = createPageLoader(() => import('./pages/pricing/PricingPage'), 'PricingPage');
export const PricingPage = lazyRoute(loadPricingPage);

export const loadProvidersPage = createPageLoader(() => import('./pages/ProvidersPage'), 'ProvidersPage');
export const ProvidersPage = lazyRoute(loadProvidersPage);

export const loadRoutingPage = createPageLoader(() => import('./pages/routing/RoutingPage'), 'RoutingPage');
export const RoutingPage = lazyRoute(loadRoutingPage);

export const loadApiKeysPage = createPageLoader(() => import('./pages/ApiKeysPage'), 'ApiKeysPage');
export const ApiKeysPage = lazyRoute(loadApiKeysPage);

export const loadDashboardPage = createPageLoader(() => import('./pages/DashboardPage'), 'DashboardPage');
export const DashboardPage = lazyRoute(loadDashboardPage);

export const loadInsightsPage = createPageLoader(() => import('./pages/insights/InsightsPage'), 'InsightsPage');
export const InsightsPage = lazyRoute(loadInsightsPage);

export const loadAgentPage = createPageLoader(() => import('./pages/agent/AgentPage'), 'AgentPage');
export const AgentPage = lazyRoute(loadAgentPage);

export const loadAuthorizePage = createPageLoader(() => import('./pages/agent/AuthorizePage'), 'AuthorizePage');
export const AuthorizePage = lazyRoute(loadAuthorizePage);

export const loadPlaygroundPage = createPageLoader(() => import('./pages/playground/PlaygroundPage'), 'PlaygroundPage');
export const PlaygroundPage = lazyRoute(loadPlaygroundPage);

export const loadModelSquarePage = createPageLoader(() => import('./pages/ModelSquarePage'), 'ModelSquarePage');
export const ModelSquarePage = lazyRoute(loadModelSquarePage);

export const loadLogsPage = createPageLoader(() => import('./pages/LogsPage'), 'LogsPage');
export const LogsPage = lazyRoute(loadLogsPage);

export const loadAuditPage = createPageLoader(() => import('./pages/AuditPage'), 'AuditPage');
export const AuditPage = lazyRoute(loadAuditPage);

export const loadConfigPage = createPageLoader(() => import('./pages/ConfigPage'), 'ConfigPage');
export const ConfigPage = lazyRoute(loadConfigPage);

export const loadOAuthManagementPage = createPageLoader(() => import('./pages/oauthManagement/OAuthManagementPage'), 'OAuthManagementPage');
export const OAuthManagementPage = lazyRoute(loadOAuthManagementPage);

export const loadLegacyOAuthManagementRedirect = createPageLoader(() => import('./pages/LegacyOAuthManagementRedirect'), 'LegacyOAuthManagementRedirect');
// A redirect draws nothing while it downloads, so it needs no early render.
export const LegacyOAuthManagementRedirect = React.lazy(loadLegacyOAuthManagementRedirect);

export const loadSystemPage = createPageLoader(() => import('./pages/SystemPage'), 'SystemPage');
export const SystemPage = lazyRoute(loadSystemPage);

export const loadPluginPageHost = createPageLoader(() => import('./pages/PluginPageHost'), 'PluginPageHost');
export const PluginPageHost = lazyRoute(loadPluginPageHost);

export const loadPluginsPage = createPageLoader(() => import('./pages/PluginsPage'), 'PluginsPage');
export const PluginsPage = lazyRoute(loadPluginsPage);

export const loadOmcSettingsPage = createPageLoader(() => import('./pages/OmcSettingsPage'), 'OmcSettingsPage');
export const OmcSettingsPage = lazyRoute(loadOmcSettingsPage);
