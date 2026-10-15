import {
  PuzzleOutlined,
  ShopOutlined,
  AuditOutlined,
  CloudServerOutlined,
  CodeSandboxOutlined,
  ControlOutlined,
  DashboardOutlined,
  DollarOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LoginOutlined,
  ProfileOutlined,
  RobotOutlined,
  SettingOutlined,
  BlockOutlined,
} from '../icons';
import { PLUGIN_PAGE_ROUTE_PREFIX, type PluginPageEntry } from '../plugins/pluginPages';
import { isRenderableLogoURL } from '../../types/pluginOAuthProviders';
import type { NavEntry, NavGroup } from '../../types/sidebarNav';

export { PLUGIN_PAGE_ROUTE_PREFIX };

/**
 * The rail's fixed destinations, grouped the way the console reasons about them: what it runs,
 * the gateway in front of those models, what it observed, and how it is controlled.
 *
 * The groups are a leaf model rather than the layout's own data so the settings page can list the
 * same entries the rail draws - the two must agree about what a rail entry is, or one of them
 * would offer a destination the other has never heard of.
 */
export const STATIC_NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'operate',
    labelKey: 'nav.group.operate',
    items: [
      { key: '/dashboard', labelKey: 'nav.dashboard', icon: <DashboardOutlined /> },
      { key: '/agent', labelKey: 'nav.agent', icon: <RobotOutlined /> },
      { key: '/playground', labelKey: 'nav.playground', icon: <CodeSandboxOutlined /> },
      { key: '/model-square', labelKey: 'nav.model_square', icon: <BlockOutlined /> },
    ],
  },
  {
    key: 'gateway',
    labelKey: 'nav.group.gateway',
    items: [
      // Upstream credentials first (provider keys, then OAuth accounts), then the keys
      // clients use to reach this gateway: the group reads in the direction a request
      // is authorised, rather than interleaving the two sides.
      { key: '/ai-providers', labelKey: 'nav.providers', icon: <CloudServerOutlined /> },
      // Authentication, credential management and quota are one credential-centred workspace.
      { key: '/oauth-management', labelKey: 'nav.auth_files', icon: <LoginOutlined /> },
      { key: '/api-keys', labelKey: 'nav.api_keys', icon: <KeyOutlined /> },
    ],
  },
  {
    key: 'observe',
    labelKey: 'nav.group.observe',
    items: [
      { key: '/usage/events', labelKey: 'nav.usage_events', icon: <HistoryOutlined /> },
      { key: '/pricing', labelKey: 'nav.pricing', icon: <DollarOutlined /> },
      { key: '/logs', labelKey: 'nav.logs', icon: <ProfileOutlined /> },
      { key: '/audit', labelKey: 'nav.audit', icon: <AuditOutlined /> },
    ],
  },
  {
    key: 'control',
    labelKey: 'nav.group.control',
    items: [
      { key: '/config', labelKey: 'nav.config', icon: <ControlOutlined /> },
      { key: '/omc-settings', labelKey: 'nav.omc_settings', icon: <SettingOutlined /> },
      { key: '/system', labelKey: 'nav.system', icon: <InfoCircleOutlined /> },
    ],
  },
];

/**
 * The full rail model: the console's own groups plus the plugins group.
 *
 * Plugins are a group of their own: what is installed, the store, and then every page a
 * running plugin registered. A plugin's page is a destination in its own right, so it sits
 * in the navigation beside the console's pages rather than behind the plugin's row. The
 * plugins group sits before Control, so the console's own control surfaces stay last.
 */
export function buildNavGroups(pluginPages: readonly PluginPageEntry[]): NavGroup[] {
  const pluginGroup: NavGroup = {
    key: 'plugins',
    labelKey: 'nav.group.plugins',
    items: [
      { key: '/plugins', labelKey: 'nav.plugins', icon: <PuzzleOutlined /> },
      { key: '/plugins/store', labelKey: 'nav.plugin_store', icon: <ShopOutlined /> },
      ...pluginPages.map((page): NavEntry => ({
        key: page.route,
        labelKey: page.navLabel,
        isLiteralLabel: true,
        icon: isRenderableLogoURL(page.logo)
          ? <img className="app-menu-plugin-logo" src={page.logo} alt="" />
          : <PuzzleOutlined />,
      })),
    ],
  };
  const controlIndex = STATIC_NAV_GROUPS.findIndex((group) => group.key === 'control');
  return [...STATIC_NAV_GROUPS.slice(0, controlIndex), pluginGroup, ...STATIC_NAV_GROUPS.slice(controlIndex)];
}
