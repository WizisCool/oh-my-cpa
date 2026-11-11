import React from 'react';
import { createNamedLoader, lazyRoute } from './utils/routeLoader';

export const loadAppLayout = createNamedLoader(() => import('./components/common/AppLayout'), 'AppLayout');
export const AppLayout = lazyRoute(loadAppLayout);

export const loadUsageEventsPage = createNamedLoader(() => import('./pages/UsageEventsPage'), 'UsageEventsPage');
export const UsageEventsPage = lazyRoute(loadUsageEventsPage);

export const loadPricingPage = createNamedLoader(() => import('./pages/pricing/PricingPage'), 'PricingPage');
export const PricingPage = lazyRoute(loadPricingPage);

export const loadProvidersPage = createNamedLoader(() => import('./pages/ProvidersPage'), 'ProvidersPage');
export const ProvidersPage = lazyRoute(loadProvidersPage);

export const loadRoutingPage = createNamedLoader(() => import('./pages/routing/RoutingPage'), 'RoutingPage');
export const RoutingPage = lazyRoute(loadRoutingPage);

export const loadApiKeysPage = createNamedLoader(() => import('./pages/ApiKeysPage'), 'ApiKeysPage');
export const ApiKeysPage = lazyRoute(loadApiKeysPage);

export const loadDashboardPage = createNamedLoader(() => import('./pages/DashboardPage'), 'DashboardPage');
export const DashboardPage = lazyRoute(loadDashboardPage);

export const loadInsightsPage = createNamedLoader(() => import('./pages/insights/InsightsPage'), 'InsightsPage');
export const InsightsPage = lazyRoute(loadInsightsPage);

export const loadAgentPage = createNamedLoader(() => import('./pages/agent/AgentPage'), 'AgentPage');
export const AgentPage = lazyRoute(loadAgentPage);

export const loadAuthorizePage = createNamedLoader(() => import('./pages/agent/AuthorizePage'), 'AuthorizePage');
export const AuthorizePage = lazyRoute(loadAuthorizePage);

export const loadPlaygroundPage = createNamedLoader(() => import('./pages/playground/PlaygroundPage'), 'PlaygroundPage');
export const PlaygroundPage = lazyRoute(loadPlaygroundPage);

export const loadModelSquarePage = createNamedLoader(() => import('./pages/ModelSquarePage'), 'ModelSquarePage');
export const ModelSquarePage = lazyRoute(loadModelSquarePage);

export const loadLogsPage = createNamedLoader(() => import('./pages/LogsPage'), 'LogsPage');
export const LogsPage = lazyRoute(loadLogsPage);

export const loadAuditPage = createNamedLoader(() => import('./pages/AuditPage'), 'AuditPage');
export const AuditPage = lazyRoute(loadAuditPage);

export const loadConfigPage = createNamedLoader(() => import('./pages/ConfigPage'), 'ConfigPage');
export const ConfigPage = lazyRoute(loadConfigPage);

export const loadOAuthManagementPage = createNamedLoader(() => import('./pages/oauthManagement/OAuthManagementPage'), 'OAuthManagementPage');
export const OAuthManagementPage = lazyRoute(loadOAuthManagementPage);

export const loadLegacyOAuthManagementRedirect = createNamedLoader(() => import('./pages/LegacyOAuthManagementRedirect'), 'LegacyOAuthManagementRedirect');
// A redirect draws nothing while it downloads, so it needs no early render.
export const LegacyOAuthManagementRedirect = React.lazy(loadLegacyOAuthManagementRedirect);

export const loadSystemPage = createNamedLoader(() => import('./pages/SystemPage'), 'SystemPage');
export const SystemPage = lazyRoute(loadSystemPage);

export const loadPluginPageHost = createNamedLoader(() => import('./pages/PluginPageHost'), 'PluginPageHost');
export const PluginPageHost = lazyRoute(loadPluginPageHost);

export const loadPluginsPage = createNamedLoader(() => import('./pages/PluginsPage'), 'PluginsPage');
export const PluginsPage = lazyRoute(loadPluginsPage);

export const loadOmcSettingsPage = createNamedLoader(() => import('./pages/OmcSettingsPage'), 'OmcSettingsPage');
export const OmcSettingsPage = lazyRoute(loadOmcSettingsPage);
