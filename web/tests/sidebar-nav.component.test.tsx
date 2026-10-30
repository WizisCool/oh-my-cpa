import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installOmcApi, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { AppLayout } from '../src/components/common/AppLayout';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { SidebarNavSettings } from '../src/components/settings/SidebarNavSettings';
import { buildNavGroups } from '../src/components/common/navigation';
import { LOCKED_NAV_KEYS, applyNavOrder, retainVisibleGroups } from '../src/types/sidebarNav';

/**
 * The sidebar panel against the real preference layer: the rows it lists and their order, the writes
 * a switch and a move make, the one row it holds inert, and that what it writes is what the rail
 * filters and orders by.
 *
 * The rail redrawing without an entry or in a new order, and either choice surviving a reload, are
 * the `sidebar-customization` browser probe's claims. What is established here is the contract
 * underneath them: one row per rail entry in the rail's own order, the stored documents named and
 * shaped like the rest of the preferences, a move inside a group writing the group's order, a move
 * across a heading writing nothing, and the filter agreeing with the write.
 */

let api: OmcApi;

/** The rail's model order, which is also the order a panel with no stored order lists. */
const MODEL_ORDER = [
  'Dashboard', 'Agent', 'Playground', 'Model Square',
  'AI providers', 'OAuth management', 'Key management', 'Routing',
  'Insights', 'Request Events', 'Cost & Usage', 'Logs', 'Audit trail',
  'Plugin management', 'Plugin store',
  'Config', 'OMC Settings', 'System Information',
];

const mount = () => renderWithOmc(<SidebarNavSettings />, { isStrict: true });

/**
 * Opens the panel. The list is a dialog rather than rows on the settings page, so every assertion
 * about a row opens it first: what the page itself carries is one row that states what the panel
 * holds.
 */
async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Manage entries' }));
  const dialog = await screen.findByTestId('sidebar-nav-dialog');
  await screen.findByRole('switch', { name: 'Dashboard' });
  return dialog;
}

/** The switches hold until the stored set has been read, so a click cannot clobber one. */
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

/** The rows in the order the panel draws them. */
const rowOrder = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('.settings-toggle-title')].map((node) => node.textContent);

/** A minimal DataTransfer: jsdom has the drag events but not the payload they carry. */
function dataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (type: string, value: string) => { store.set(type, value); },
    getData: (type: string) => store.get(type) ?? '',
  };
}

beforeEach(() => {
  api = installOmcApi();
});

describe('sidebar layout panel', () => {
  it('lists every rail entry once, in the rail\'s own order, with the entry that owns the rail inert', async () => {
    const { container } = mount();
    const page = container.querySelector('[data-testid="sidebar-nav-settings"]')!;
    expect([...page.querySelectorAll('.settings-toggle-title')].map((node) => node.textContent))
      .toEqual(['Sidebar entries']);
    expect(page.querySelector('.settings-toggle-desc')?.textContent).toBe('Every entry is shown');

    const dialog = await openPanel();
    const titles = [...dialog.querySelectorAll('.settings-toggle-title')].map((node) => node.textContent);
    // The console's groups, then the plugins group before Control, because that is where the rail
    // puts them.
    expect(titles).toEqual(MODEL_ORDER);
    const settingsToggle = screen.getByRole('switch', { name: 'OMC Settings' });
    expect(settingsToggle.hasAttribute('disabled')).toBe(true);
    expect(settingsToggle.getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('.settings-toggle-desc')?.textContent).toBe('This entry manages the sidebar, so it always shows.');
    // Nothing is hidden and nothing is rearranged on a fresh deployment, so neither reset has
    // anything to put back.
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset order' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides an entry by writing the hidden set, and that set is what the rail filters by', async () => {
    const { container } = mount();
    await openPanel();
    const agent = await readySwitch('Agent');
    expect(agent.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(agent);
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({ key: 'omc_nav_hidden', value: ['/agent'] });
    expect(agent.getAttribute('aria-checked')).toBe('false');
    // The rail is built from this same set, so the entry the panel just hid is gone from it.
    const railKeys = retainVisibleGroups(buildNavGroups([]), new Set(['/agent']))
      .flatMap((group) => group.items.map((item) => item.key));
    expect(railKeys).not.toContain('/agent');
    expect(railKeys).toContain('/playground');
    // The page reads without opening the panel: the row states how many entries are out of the rail.
    expect(container.querySelector('[data-testid="sidebar-nav-settings"] .settings-toggle-desc')?.textContent).toBe('1 hidden');
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads a stored hidden set back, dropping anything the store should never have accepted', async () => {
    api.state.preferences.omc_nav_hidden = ['/agent', '/omc-settings', 'not-a-route', 42];
    mount();
    await openPanel();
    const agent = await readySwitch('Agent');
    expect(agent.getAttribute('aria-checked')).toBe('false');
    const settingsToggle = screen.getByRole('switch', { name: 'OMC Settings' });
    expect(settingsToggle.getAttribute('aria-checked')).toBe('true');
    expect(settingsToggle.hasAttribute('disabled')).toBe(true);
    expect(LOCKED_NAV_KEYS.has('/omc-settings')).toBe(true);
    // Showing everything writes the empty set rather than re-sending anything that was dropped.
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({ key: 'omc_nav_hidden', value: [] });
    expect(agent.getAttribute('aria-checked')).toBe('true');
  });

  it('does not report an entry the rail no longer draws as hidden', async () => {
    // The stored document is input, not state: a key whose destination is gone - a plugin page
    // whose plugin stopped - is not an entry out of the rail, so the row says as much and the
    // reset stays inert rather than offering to put back something that was never taken away.
    api.state.preferences.omc_nav_hidden = ['/plugin-pages/gone/0'];
    const { container } = mount();
    expect(container.querySelector('[data-testid="sidebar-nav-settings"] .settings-toggle-desc')?.textContent)
      .toBe('Every entry is shown');
    await openPanel();
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('switch', { name: 'Agent' }).getAttribute('aria-checked')).toBe('true');
  });

  it('moves an entry with the step buttons, writing each group\'s order', async () => {
    mount();
    const dialog = await openPanel();
    fireEvent.click(await readyButton('Move earlier · Playground'));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({
      key: 'omc_nav_order',
      value: { operate: ['/dashboard', '/playground', '/agent', '/model-square'] },
    });
    expect(rowOrder(dialog).slice(0, 4)).toEqual(['Dashboard', 'Playground', 'Agent', 'Model Square']);
    // The rail is built from this same document, so the entry is in its new place there too; the
    // order is console state, like the hidden set, and hiding was untouched.
    const railKeys = applyNavOrder(buildNavGroups([]), { operate: ['/dashboard', '/playground', '/agent', '/model-square'] })
      .flatMap((group) => group.items.map((item) => item.key));
    expect(railKeys.slice(0, 4)).toEqual(['/dashboard', '/playground', '/agent', '/model-square']);
    expect((screen.getByRole('button', { name: 'Reset order' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders on a drag from the handle, and refuses a drag that was not armed or crosses a heading', async () => {
    mount();
    const dialog = await openPanel();
    await readySwitch('Agent');
    const drag = dataTransfer();
    // jsdom has no layout, so every row's midpoint is 0: a drop at clientY 0 lands after the row.
    const rowOf = (key: string) => dialog.querySelector(`[data-nav-row="${key}"]`)!;
    const handleOf = (key: string) => dialog.querySelector(`[data-nav-handle="${key}"]`)!;

    // A row is draggable only after its handle was pressed, exactly as the browser arms it.
    fireEvent.pointerDown(handleOf('/dashboard'));
    fireEvent.dragStart(rowOf('/dashboard'), { dataTransfer: drag });
    fireEvent.dragOver(rowOf('/agent'), { dataTransfer: drag, clientY: 0 });
    fireEvent.drop(rowOf('/agent'), { dataTransfer: drag, clientY: 0 });
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({
      key: 'omc_nav_order',
      value: { operate: ['/agent', '/dashboard', '/playground', '/model-square'] },
    });
    expect(rowOrder(dialog).slice(0, 3)).toEqual(['Agent', 'Dashboard', 'Playground']);

    // The groups say what an entry is, so a drop across a heading is not an ordering choice.
    fireEvent.pointerDown(handleOf('/playground'));
    fireEvent.dragStart(rowOf('/playground'), { dataTransfer: drag });
    fireEvent.dragOver(rowOf('/logs'), { dataTransfer: drag, clientY: 0 });
    fireEvent.drop(rowOf('/logs'), { dataTransfer: drag, clientY: 0 });
    await act(async () => {});
    expect(rowOrder(dialog).slice(0, 3)).toEqual(['Agent', 'Dashboard', 'Playground']);

    // A drag that did not start at the handle is refused: selecting label text and dragging it
    // must not reorder the rail either.
    fireEvent.dragStart(rowOf('/dashboard'), { dataTransfer: drag });
    fireEvent.dragOver(rowOf('/playground'), { dataTransfer: drag, clientY: 0 });
    fireEvent.drop(rowOf('/playground'), { dataTransfer: drag, clientY: 0 });
    await act(async () => {});
    expect(rowOrder(dialog).slice(0, 3)).toEqual(['Agent', 'Dashboard', 'Playground']);
  });

  it('neither reset touches the other setting', async () => {
    api.state.preferences.omc_nav_hidden = ['/agent'];
    api.state.preferences.omc_nav_order = { operate: ['/playground', '/dashboard'] };
    mount();
    const dialog = await openPanel();
    await waitFor(() => expect(rowOrder(dialog).slice(0, 2)).toEqual(['Playground', 'Dashboard']));
    const agent = await readySwitch('Agent');
    expect(agent.getAttribute('aria-checked')).toBe('false');

    // Show all is visibility only, and it runs while a custom order is still stored: it puts the
    // entry back and leaves the order document alone.
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
    expect(api.preferenceWrites()[0]).toEqual({ key: 'omc_nav_hidden', value: [] });
    expect(agent.getAttribute('aria-checked')).toBe('true');
    expect(rowOrder(dialog).slice(0, 2)).toEqual(['Playground', 'Dashboard']);
    expect(api.preferenceWrites().filter((write) => write.key === 'omc_nav_order')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Reset order' }) as HTMLButtonElement).disabled).toBe(false);

    // And Reset order is order only: the visibility setting stays as it is.
    fireEvent.click(await readyButton('Reset order'));
    await waitFor(() => expect(api.preferenceWrites()).toHaveLength(2));
    expect(api.preferenceWrites()[1]).toEqual({ key: 'omc_nav_order', value: {} });
    expect(rowOrder(dialog)).toEqual(MODEL_ORDER);
    expect(agent.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Shell wiring owns hydration and the shared preference hook owns write serialization/rollback. */
describe('desktop sidebar preference', () => {
  const mountShell = () => renderWithOmc(<ThemeProvider><AppLayout /></ThemeProvider>, { route: '/dashboard', isStrict: true });

  beforeEach(() => {
    api.on('GET', '/management/system/repository', () => ({ stargazers_count: 0 }));
    api.on('GET', '/management/system/updates', () => ({ omc_version: { state: 'unchecked' }, cpa_version: { state: 'unchecked' } }));
  });

  it('waits for the stored choice before admitting a toggle and never writes during hydration', async () => {
    api.state.preferences.omc_sidebar_collapsed = true;
    const read = api.hold('GET', '/preferences');
    mountShell();
    await read.arrived;
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(api.preferenceWrites()).toEqual([]);
    await act(async () => { read.release(); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Expand sidebar' }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.preferenceWrites()).toEqual([]);
  });

  it('uses the shared rollback when expanding the collapsed brand is refused', async () => {
    api.state.preferences.omc_sidebar_collapsed = true;
    mountShell();
    await screen.findByRole('button', { name: 'Expand sidebar' });
    const write = api.hold('PUT', '/preferences/omc_sidebar_collapsed');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Expand Sider' }), { key: 'Enter' });
    await write.arrived;
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    await act(async () => { write.release(new Response('{"error":"write_busy"}', { status: 503 })); });
    await screen.findByRole('button', { name: 'Expand sidebar' });
    expect(api.preferenceWrites()).toEqual([{ key: 'omc_sidebar_collapsed', value: false }]);
    expect(api.state.preferences.omc_sidebar_collapsed).toBe(true);
  });
});
