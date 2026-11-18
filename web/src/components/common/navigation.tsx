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
  InsightsOutlined,
  KeyOutlined,
  LineChartOutlined,
  LayersOutlined,
  LoginOutlined,
  ProfileOutlined,
  RobotOutlined,
  SettingOutlined,
  BlockOutlined,
} from '../icons';
import { PLUGIN_PAGE_ROUTE_PREFIX, type PluginPageEntry } from '../plugins/pluginPages';
import { PluginIcon } from '../plugins/PluginIcon';
import {
  PLUGIN_STATIC_NAV_ITEMS,
  STATIC_NAV_GROUP_SPECS,
  type NavEntry,
  type NavEntrySpec,
  type NavGroup,
} from '../../types/sidebarNav';

export { PLUGIN_PAGE_ROUTE_PREFIX };

const NAV_ENTRY_ICONS: Readonly<Record<string, React.ReactNode>> = {
  '/dashboard': <DashboardOutlined />,
  '/agent': <RobotOutlined />,
  '/playground': <CodeSandboxOutlined />,
  '/model-square': <BlockOutlined />,
  '/ai-providers': <CloudServerOutlined />,
  '/oauth-management': <LoginOutlined />,
  '/api-keys': <KeyOutlined />,
  '/routing': <LayersOutlined />,
  '/insights': <InsightsOutlined />,
  '/trends': <LineChartOutlined />,
  '/usage/events': <HistoryOutlined />,
  '/pricing': <DollarOutlined />,
  '/logs': <ProfileOutlined />,
  '/audit': <AuditOutlined />,
  '/plugins': <PuzzleOutlined />,
  '/plugins/store': <ShopOutlined />,
  '/config': <ControlOutlined />,
  '/omc-settings': <SettingOutlined />,
  '/system': <InfoCircleOutlined />,
};

function toNavEntry(spec: NavEntrySpec): NavEntry {
  return {
    key: spec.key,
    labelKey: spec.labelKey,
    icon: NAV_ENTRY_ICONS[spec.key] ?? <ProfileOutlined />,
  };
}

/**
 * The rail's fixed destinations, derived from `STATIC_NAV_GROUP_SPECS` so the live sidebar and
 * the boot skeleton (`ShellLoading`) share one canonical source of destinations.
 */
export const STATIC_NAV_GROUPS: readonly NavGroup[] = STATIC_NAV_GROUP_SPECS.map((group) => ({
  key: group.key,
  labelKey: group.labelKey,
  items: group.items.map(toNavEntry),
}));

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
      ...PLUGIN_STATIC_NAV_ITEMS.map(toNavEntry),
      ...pluginPages.map((page): NavEntry => ({
        key: page.route,
        labelKey: page.navLabel,
        isLiteralLabel: true,
        icon: <PluginIcon className="app-menu-plugin-logo" logo={page.logo} />,
      })),
    ],
  };
  const controlIndex = STATIC_NAV_GROUPS.findIndex((group) => group.key === 'control');
  return [...STATIC_NAV_GROUPS.slice(0, controlIndex), pluginGroup, ...STATIC_NAV_GROUPS.slice(controlIndex)];
}
