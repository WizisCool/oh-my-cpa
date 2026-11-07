import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installOmcApi, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { AppLayout } from '../src/components/common/AppLayout';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { SidebarNavSettings } from '../src/components/settings/SidebarNavSettings';
import { buildNavGroups } from '../src/components/common/navigation';
import { UPDATE_STATUS_QUERY_KEY } from '../src/hooks/useUpdateNotice';
import { LOCKED_NAV_KEYS, applyNavOrder, retainVisibleGroups } from '../src/types/sidebarNav';

let api: OmcApi;

const MODEL_ORDER = [
  'Dashboard', 'Agent', 'Playground', 'Model Square',
  'AI providers', 'OAuth management', 'Key management', 'Routing',
  'Insights', 'Request Events', 'Cost & Usage', 'Logs', 'Audit trail',
  'Plugin management', 'Plugin store',
  'Config', 'OMC Settings', 'System Information',
];

const mount = () => renderWithOmc(<SidebarNavSettings />, { isStrict: true });

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Manage entries' }));
  const dialog = await screen.findByTestId('sidebar-nav-dialog');
  await screen.findByRole('switch', { name: 'Dashboard' });
  return dialog;
}

async function readySwitch(accessibilityName: string) {
  const control = await screen.findByRole('switch', { name: accessibilityName });
  await waitFor(() => expect(control.hasAttribute('disabled')).toBe(false));
  return control;
}

async function readyButton(accessibilityName: string) {
  const button = await screen.findByRole('button', { name: accessibilityName });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

const rowOrder = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('.settings-toggle-title')].map((node) => node.textContent);

beforeEach(() => {
  api = installOmcApi();
});

describe('sidebar layout panel', () => {
  it('lists rail entries in model order, locks OMC Settings, hides entries, and resets visibility', async () => {
    const { container } = mount();
    const dialog = await openPanel();
    expect(rowOrder(dialog)).toEqual(MODEL_ORDER);
    const settingsToggle = screen.getByRole('switch', { name: 'OMC Settings' });
    expect(settingsToggle.hasAttribute('disabled')).toBe(true);
    expect(LOCKED_NAV_KEYS.has('/omc-settings')).toBe(true);

    const agent = await readySwitch('Agent');
    fireEvent.click(agent);
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({ key: 'omc_nav_hidden', value: ['/agent'] });

    const railKeys = retainVisibleGroups(buildNavGroups([]), new Set(['/agent']))
      .flatMap((group) => group.items.map((item) => item.key));
    expect(railKeys).not.toContain('/agent');
    expect(container.querySelector('[data-testid="sidebar-nav-settings"] .settings-toggle-desc')?.textContent).toBe('1 hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(2));
    expect(api.preferenceWrites()[1]).toEqual({ key: 'omc_nav_hidden', value: [] });
  });

  it('reorders entries within their group and resets order without affecting visibility', async () => {
    api.state.preferences.omc_nav_hidden = ['/agent'];
    mount();
    const dialog = await openPanel();
    fireEvent.click(await readyButton('Move earlier · Playground'));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({
      key: 'omc_nav_order',
      value: { operate: ['/dashboard', '/playground', '/agent', '/model-square'] },
    });
    expect(rowOrder(dialog).slice(0, 4)).toEqual(['Dashboard', 'Playground', 'Agent', 'Model Square']);

    const railKeys = applyNavOrder(buildNavGroups([]), { operate: ['/dashboard', '/playground', '/agent', '/model-square'] })
      .flatMap((group) => group.items.map((item) => item.key));
    expect(railKeys.slice(0, 4)).toEqual(['/dashboard', '/playground', '/agent', '/model-square']);

    fireEvent.click(await readyButton('Reset order'));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(2));
    expect(api.preferenceWrites()[1]).toEqual({ key: 'omc_nav_order', value: {} });
    expect(rowOrder(dialog)).toEqual(MODEL_ORDER);
    expect(screen.getByRole('switch', { name: 'Agent' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('desktop sidebar preference', () => {
  it('waits for hydration before admitting a toggle and rolls back on write failure', async () => {
    api.on('GET', '/management/system/repository', () => ({ stargazers_count: 0 }));
    api.on('GET', '/management/system/updates', () => ({ omc_version: { state: 'unchecked' }, cpa_version: { state: 'unchecked' } }));
    api.state.preferences.omc_sidebar_collapsed = true;
    const read = api.hold('GET', '/preferences');
    renderWithOmc(<ThemeProvider><AppLayout /></ThemeProvider>, { route: '/dashboard', isStrict: true });
    await read.arrived;
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { read.release(); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Expand sidebar' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

it('keeps plugin and system update reminders independent as observations change', async () => {
  api.on('GET', '/management/system/repository', () => ({ stargazers_count: 0 }));
  let hasPluginUpdate = true;
  api.on('GET', '/management/system/updates', () => ({
    omc_version: { product: 'omc', state: 'update_available', latest_version: 'v1.1.0' },
    cpa_version: { product: 'cpa', state: 'up_to_date' },
    plugin_update_available: hasPluginUpdate,
  }));
  const surface = renderWithOmc(<ThemeProvider><AppLayout /></ThemeProvider>, { route: '/dashboard', isStrict: true });
  const dot = (route: string) => surface.container.querySelector(`[data-route-path="${route}"] [data-testid="nav-update-dot"]`);
  await waitFor(() => {
    expect(dot('/system')).not.toBeNull();
    expect(dot('/plugins')).not.toBeNull();
  });
  expect(dot('/plugins/store')).toBeNull();

  hasPluginUpdate = false;
  await act(async () => { await surface.client.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY }); });
  await waitFor(() => expect(dot('/plugins')).toBeNull());
  expect(dot('/system')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
  await screen.findByRole('button', { name: 'Expand sidebar' });
  hasPluginUpdate = true;
  await act(async () => { await surface.client.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY }); });
  await waitFor(() => expect(dot('/plugins')).not.toBeNull());
  expect(dot('/system')).not.toBeNull();
});
