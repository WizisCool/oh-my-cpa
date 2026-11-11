import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installOmcApi, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { AppLayout } from '../src/components/common/AppLayout';
import { NavSelectionHighlight } from '../src/components/common/NavSelectionHighlight';
import { consoleRouteRegistry } from '../src/routePreload';
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

describe('sidebar selection highlight', () => {
  const mockBox = (top: number, height = 32): DOMRect =>
    ({ top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  function mountHighlight(selectedKey: string, groupKey: string | null, layoutKey = 'expanded|init') {
    const tree = (key: string, group: string | null, layout: string) => (
      <NavSelectionHighlight selectedKey={key} groupKey={group} layoutKey={layout}>
        <div>
          <div data-route-path="/dashboard">Dashboard</div>
          <div data-route-path="/agent">Agent</div>
          <div data-route-path="/logs">Logs</div>
        </div>
      </NavSelectionHighlight>
    );
    const view = render(tree(selectedKey, groupKey, layoutKey));
    const frame = view.container.querySelector<HTMLElement>('.app-menu-frame')!;
    frame.getBoundingClientRect = () => mockBox(0, 140);
    view.container.querySelector<HTMLElement>('[data-route-path="/dashboard"]')!.getBoundingClientRect = () => mockBox(24);
    view.container.querySelector<HTMLElement>('[data-route-path="/agent"]')!.getBoundingClientRect = () => mockBox(58);
    view.container.querySelector<HTMLElement>('[data-route-path="/logs"]')!.getBoundingClientRect = () => mockBox(108);
    return {
      ...view,
      layers: () => [...view.container.querySelectorAll<HTMLElement>('.app-menu-highlight')],
      rerenderState: (nextKey: string, nextGroup: string | null, nextLayout = layoutKey) =>
        view.rerender(tree(nextKey, nextGroup, nextLayout)),
    };
  }

  it('slides within a group, cross-fades across groups without blinking on rapid bounce, and clears ghost layers on layout shift', () => {
    const { layers, rerenderState } = mountHighlight('/dashboard', 'operate');
    // Re-apply initial layout after attaching geometry mocks to the mounted nodes.
    rerenderState('/dashboard', 'operate', 'expanded|ready');
    const [layer0, layer1] = layers();
    expect(layer0?.style.opacity).toBe('1');
    expect(layer0?.style.transform).toBe('translate3d(0, 24px, 0)');
    expect(layer1?.style.opacity).toBe('0');

    // Same-group navigation slides the active layer in place.
    rerenderState('/agent', 'operate', 'expanded|ready');
    expect(layer0?.style.opacity).toBe('1');
    expect(layer0?.style.transform).toBe('translate3d(0, 58px, 0)');
    expect(layer1?.style.opacity).toBe('0');

    // Cross-group navigation cross-fades onto the second layer.
    rerenderState('/logs', 'observe', 'expanded|ready');
    expect(layer0?.style.opacity).toBe('0');
    expect(layer1?.style.opacity).toBe('1');
    expect(layer1?.style.transform).toBe('translate3d(0, 108px, 0)');

    // Clicking back to the row whose layer is still fading out reverses opacity directly instead of snapping to 0.
    let snappedToZero = false;
    const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'opacity');
    const origSet = descriptor?.set;
    if (layer0 && origSet) {
      Object.defineProperty(layer0.style, 'opacity', {
        configurable: true,
        get: () => descriptor.get?.call(layer0.style),
        set: (value: string) => {
          if (value === '0') snappedToZero = true;
          origSet.call(layer0.style, value);
        },
      });
    }
    rerenderState('/agent', 'operate', 'expanded|ready');
    expect(snappedToZero).toBe(false);
    expect(layer0?.style.opacity).toBe('1');
    expect(layer1?.style.opacity).toBe('0');

    // A layout change (collapse/reorder) snaps cleanly and hides the inactive layer.
    rerenderState('/agent', 'operate', 'collapsed|ready');
    expect(layer0?.style.opacity).toBe('1');
    expect(layer1?.style.opacity).toBe('0');
  });

  it('answers brand logo clicks and preserves slide vs cross-fade in collapsed rail mode', async () => {
    vi.spyOn(consoleRouteRegistry, 'scheduleIdlePrewarm').mockReturnValue(() => undefined);
    vi.spyOn(consoleRouteRegistry, 'preloadChunk').mockResolvedValue(undefined);
    vi.spyOn(consoleRouteRegistry, 'warmIntent').mockImplementation(() => undefined);
    api.on('GET', '/management/system/repository', () => ({ stargazers_count: 0 }));
    api.on('GET', '/management/system/updates', () => ({ omc_version: { state: 'unchecked' }, cpa_version: { state: 'unchecked' } }));
    const surface = renderWithOmc(<ThemeProvider><AppLayout /></ThemeProvider>, { route: '/logs', isStrict: true });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Collapse sidebar' }) as HTMLButtonElement).disabled).toBe(false));

    // Clicking the expanded brand logo navigates to /dashboard and updates rail selection.
    const brand = surface.container.querySelector<HTMLElement>('.app-brand')!;
    fireEvent.click(brand);
    await waitFor(() => {
      expect(surface.container.querySelector('[data-route-path="/dashboard"]')?.classList.contains('ant-menu-item-selected')).toBe(true);
    });

    // Collapse the rail: group headings disappear, while group identity still governs slide vs cross-fade.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await screen.findByRole('button', { name: 'Expand sidebar' });
    expect(surface.container.querySelector('.ant-menu-item-group-title')).toBeNull();

    const frame = surface.container.querySelector<HTMLElement>('.app-menu-frame')!;
    const agent = surface.container.querySelector<HTMLElement>('[data-route-path="/agent"]')!;
    const modelSquare = surface.container.querySelector<HTMLElement>('[data-route-path="/model-square"]')!;
    const providers = surface.container.querySelector<HTMLElement>('[data-route-path="/ai-providers"]')!;
    frame.getBoundingClientRect = () => mockBox(0, 600);
    surface.container.querySelector<HTMLElement>('[data-route-path="/dashboard"]')!.getBoundingClientRect = () => mockBox(0);
    agent.getBoundingClientRect = () => mockBox(34);
    modelSquare.getBoundingClientRect = () => mockBox(102);
    providers.getBoundingClientRect = () => mockBox(136);

    // Same-group move (/dashboard -> /model-square in Operate) slides the active layer.
    fireEvent.click(modelSquare);
    await waitFor(() => expect(modelSquare.classList.contains('ant-menu-item-selected')).toBe(true));
    const [layer0, layer1] = [...surface.container.querySelectorAll<HTMLElement>('.app-menu-highlight')];
    expect(layer0?.style.opacity).toBe('1');
    expect(layer0?.style.transform).toBe('translate3d(0, 102px, 0)');
    expect(layer1?.style.opacity).toBe('0');

    // Cross-group move (/model-square in Operate -> /ai-providers in Gateway) cross-fades to the second layer.
    fireEvent.click(providers);
    await waitFor(() => expect(providers.classList.contains('ant-menu-item-selected')).toBe(true));
    expect(layer0?.style.opacity).toBe('0');
    expect(layer1?.style.opacity).toBe('1');
    expect(layer1?.style.transform).toBe('translate3d(0, 136px, 0)');
  });
});
