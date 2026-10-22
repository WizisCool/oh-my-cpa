import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installOmcApi, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { SidebarNavSettings } from '../src/components/settings/SidebarNavSettings';
import { buildNavGroups } from '../src/components/common/navigation';
import { LOCKED_NAV_KEYS, retainVisibleGroups } from '../src/types/sidebarNav';

/**
 * The sidebar panel against the real preference layer: the rows it lists and their order, the write
 * a switch makes, the one row it holds inert, and that what it writes is what the rail filters by.
 *
 * The rail redrawing without an entry, and the choice surviving a reload, are the
 * `sidebar-customization` browser probe's claims. What is established here is the contract
 * underneath them: one row per rail entry in the rail's own order, the stored document named and
 * shaped like the rest of the preferences, and the filter agreeing with the write.
 */

let api: OmcApi;

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

beforeEach(() => {
  api = installOmcApi();
});

describe('sidebar visibility panel', () => {
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
    expect(titles).toEqual([
      'Dashboard', 'Agent', 'Playground', 'Model Square',
      'AI providers', 'OAuth management', 'Key management',
      'Request Events', 'Cost & Usage', 'Logs', 'Audit trail',
      'Plugin management', 'Plugin store',
      'Config', 'OMC Settings', 'System Information',
    ]);
    const settingsToggle = screen.getByRole('switch', { name: 'OMC Settings' });
    expect(settingsToggle.hasAttribute('disabled')).toBe(true);
    expect(settingsToggle.getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('.settings-toggle-desc')?.textContent).toBe('This entry manages the sidebar, so it always shows.');
    // Nothing is hidden on a fresh deployment, so the reset has nothing to put back.
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
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
});
