import React from 'react';
import { createRouteLoader } from './utils/routeLoader';

// Selection is shared by intent preloads and navigation without repeating it in every entry import.
function createPageLoader<Module, Name extends keyof Module>(importModule: () => Promise<Module>, name: Name) {
  return createRouteLoader(async () => ({ default: (await importModule())[name] }));
}

export const loadUsageEventsPage = createPageLoader(() => import('./pages/UsageEventsPage'), 'UsageEventsPage');
export const UsageEventsPage = React.lazy(loadUsageEventsPage);

export const loadPricingPage = createPageLoader(() => import('./pages/pricing/PricingPage'), 'PricingPage');
export const PricingPage = React.lazy(loadPricingPage);

export const loadProvidersPage = createPageLoader(() => import('./pages/ProvidersPage'), 'ProvidersPage');
export const ProvidersPage = React.lazy(loadProvidersPage);

export const loadApiKeysPage = createPageLoader(() => import('./pages/ApiKeysPage'), 'ApiKeysPage');
export const ApiKeysPage = React.lazy(loadApiKeysPage);

export const loadDashboardPage = createPageLoader(() => import('./pages/DashboardPage'), 'DashboardPage');
export const DashboardPage = React.lazy(loadDashboardPage);

export const loadAgentPage = createPageLoader(() => import('./pages/agent/AgentPage'), 'AgentPage');
export const AgentPage = React.lazy(loadAgentPage);

export const loadAuthorizePage = createPageLoader(() => import('./pages/agent/AuthorizePage'), 'AuthorizePage');
export const AuthorizePage = React.lazy(loadAuthorizePage);

export const loadPlaygroundPage = createPageLoader(() => import('./pages/playground/PlaygroundPage'), 'PlaygroundPage');
export const PlaygroundPage = React.lazy(loadPlaygroundPage);

export const loadModelSquarePage = createPageLoader(() => import('./pages/ModelSquarePage'), 'ModelSquarePage');
export const ModelSquarePage = React.lazy(loadModelSquarePage);

export const loadLogsPage = createPageLoader(() => import('./pages/LogsPage'), 'LogsPage');
export const LogsPage = React.lazy(loadLogsPage);

export const loadAuditPage = createPageLoader(() => import('./pages/AuditPage'), 'AuditPage');
export const AuditPage = React.lazy(loadAuditPage);

export const loadConfigPage = createPageLoader(() => import('./pages/ConfigPage'), 'ConfigPage');
export const ConfigPage = React.lazy(loadConfigPage);

export const loadOAuthManagementPage = createPageLoader(() => import('./pages/oauthManagement/OAuthManagementPage'), 'OAuthManagementPage');
export const OAuthManagementPage = React.lazy(loadOAuthManagementPage);

export const loadLegacyOAuthManagementRedirect = createPageLoader(() => import('./pages/LegacyOAuthManagementRedirect'), 'LegacyOAuthManagementRedirect');
export const LegacyOAuthManagementRedirect = React.lazy(loadLegacyOAuthManagementRedirect);

export const loadSystemPage = createPageLoader(() => import('./pages/SystemPage'), 'SystemPage');
export const SystemPage = React.lazy(loadSystemPage);

export const loadPluginPageHost = createPageLoader(() => import('./pages/PluginPageHost'), 'PluginPageHost');
export const PluginPageHost = React.lazy(loadPluginPageHost);

export const loadPluginsPage = createPageLoader(() => import('./pages/PluginsPage'), 'PluginsPage');
export const PluginsPage = React.lazy(loadPluginsPage);

export const loadOmcSettingsPage = createPageLoader(() => import('./pages/OmcSettingsPage'), 'OmcSettingsPage');
export const OmcSettingsPage = React.lazy(loadOmcSettingsPage);
