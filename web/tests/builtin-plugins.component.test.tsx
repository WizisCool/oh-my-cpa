import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PluginsPage } from '../src/pages/PluginsPage';
import type { BuiltinPlugin, BuiltinPluginsResponse, OmcCommunityPluginsResponse, PluginStoreResponse, StorePluginItem } from '../src/types/plugin';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const ZCODE: BuiltinPlugin = {
  id: 'omc-zcode-oauth', name: 'ZCode OAuth', description: 'ZCode OAuth provider', description_i18n: { en: 'Signs in to ZCode.' },
  version: '0.2.0', source_id: 'builtin', source_kind: 'builtin', policy: { enabled: true },
  status: 'running', installed_version: '0.1.4', runtime_version: '0.1.4', registered: true, effective_enabled: true, reason: '',
};

function builtins(overrides: Partial<BuiltinPluginsResponse> = {}): BuiltinPluginsResponse {
  return {
    policy: { enabled: true, revision: 4 },
    catalog: { status: 'ready', revision: 'r1' },
    plugins: [ZCODE],
    last_reconcile_at: '',
    ...overrides,
  };
}

function writes(api: ReturnType<typeof installOmcApi>, path: string) {
  return api.requests.filter((request) => request.method === 'PUT' && request.path === path);
}

function reads(api: ReturnType<typeof installOmcApi>) {
  return api.requests.filter((request) => request.method === 'GET' && request.path === '/management/builtin-plugins').length;
}

it('is on by default and switches the whole feature and one plugin with explicit values', async () => {
  const api = installOmcApi();
  let state = builtins();
  api.on('GET', '/management/builtin-plugins', () => state);
  api.on('PUT', '/management/builtin-plugins/policy', (request) => {
    const body = request.body as { enabled: boolean; revision: number };
    // Switching on starts a run; the worker stamps it when it completes.
    state = builtins({ policy: { enabled: body.enabled, revision: body.revision + 1 }, last_reconcile_at: `run-${body.revision}` });
    return state;
  });
  api.on('PUT', '/management/builtin-plugins/omc-zcode-oauth/policy', (request) => {
    const body = request.body as { enabled: boolean; revision: number };
    state = builtins({ policy: { enabled: true, revision: body.revision + 1 }, plugins: [{ ...ZCODE, policy: { enabled: body.enabled } }] });
    return state;
  });
  renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });

  expect((await screen.findByRole('switch', { name: 'Built-in plugins' })).getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('button', { name: /Authorize/ })).toBeNull();

  fireEvent.click(screen.getByRole('switch', { name: 'Built-in plugins' }));
  await waitFor(() => expect(writes(api, '/management/builtin-plugins/policy')).toHaveLength(1));
  expect(writes(api, '/management/builtin-plugins/policy')[0].body).toEqual({ enabled: false, revision: 4 });
  // Off, OMC has uninstalled its copies: the switch's card is all the page shows.
  await waitFor(() => expect(screen.queryByRole('article')).toBeNull());

  fireEvent.click(screen.getByRole('switch', { name: 'Built-in plugins' }));
  await waitFor(() => expect(writes(api, '/management/builtin-plugins/policy')).toHaveLength(2));
  expect(writes(api, '/management/builtin-plugins/policy')[1].body).toEqual({ enabled: true, revision: 5 });
  // Switching on reports once the run it started has finished, not when it was accepted.
  expect(await screen.findByText('Built-in plugins are on', {}, { timeout: 5000 })).toBeTruthy();

  fireEvent.click(screen.getByRole('switch', { name: 'Enable or disable ZCode OAuth' }));
  await waitFor(() => expect(writes(api, '/management/builtin-plugins/omc-zcode-oauth/policy')).toHaveLength(1));
  expect(writes(api, '/management/builtin-plugins/omc-zcode-oauth/policy')[0].body).toEqual({ enabled: false, revision: 6 });
});

it('reports what a check did once the worker has finished it, and says when it cannot tell', async () => {
  const api = installOmcApi();
  let state = builtins({ last_reconcile_at: '2026-10-31T10:00:00Z' });
  api.on('GET', '/management/builtin-plugins', () => state);
  api.on('POST', '/management/builtin-plugins/reconcile', () => {
    const accepted = state;
    state = builtins({ last_reconcile_at: '2026-10-31T10:05:00Z', plugins: [{ ...ZCODE, installed_version: '0.2.0', runtime_version: '0.2.0' }] });
    return accepted;
  });
  const first = renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });
  const firstCheck = await screen.findByRole('button', { name: 'Check for updates' }) as HTMLButtonElement;
  await waitFor(() => expect(firstCheck.disabled).toBe(false));
  fireEvent.click(firstCheck);
  expect(await screen.findByText('Check complete', {}, { timeout: 5000 })).toBeTruthy();
  expect(screen.getByText('Updated ZCode OAuth to v0.2.0.')).toBeTruthy();
  first.unmount();

  // A run that never completes leaves the stamp alone: the outcome is unknown, not a success.
  const stalled = installOmcApi();
  stalled.on('GET', '/management/builtin-plugins', () => builtins({ last_reconcile_at: '2026-10-31T10:00:00Z' }));
  stalled.on('POST', '/management/builtin-plugins/reconcile', () => builtins({ last_reconcile_at: '2026-10-31T10:00:00Z' }));
  renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });
  const check = await screen.findByRole('button', { name: 'Check for updates' }) as HTMLButtonElement;
  await waitFor(() => expect(check.disabled).toBe(false));
  vi.useFakeTimers();
  try {
    fireEvent.click(check);
    await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByText('Outcome not confirmed')).toBeTruthy();
  expect(screen.getByText(/No result within 45 seconds/)).toBeTruthy();
  expect(screen.queryByText('Check complete')).toBeNull();
});

it('shows an automatically installed builtin without requiring a manual refresh', async () => {
  const api = installOmcApi();
  let state = builtins({ plugins: [{ ...ZCODE, status: 'not_installed', installed_version: '', runtime_version: '', registered: false, effective_enabled: false }] });
  api.on('GET', '/management/builtin-plugins', () => state);
  const { client } = renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });
  expect(await screen.findByText('Not installed')).toBeTruthy();
  vi.useFakeTimers();
  try {
    await act(async () => { await client.invalidateQueries({ queryKey: ['management-builtin-plugins'] }); });
    state = builtins();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(reads(api)).toBeGreaterThanOrEqual(3);
    expect(within(screen.getByRole('article')).getByText('Running')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['policy_revision_conflict', 409, /changed elsewhere/],
  ['builtin_policy_apply_incomplete', 502, /saved, but the gateway has not confirmed/],
  ['', 500, /Could not confirm whether the change was saved/],
])('re-reads after a failure coded "%s" instead of resending the override', async (code, status, message) => {
  const api = installOmcApi();
  api.on('GET', '/management/builtin-plugins', () => builtins());
  api.on('PUT', '/management/builtin-plugins/omc-zcode-oauth/policy', () => json({ error: 'refused', code }, status));
  renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });

  fireEvent.click(await screen.findByRole('switch', { name: 'Enable or disable ZCode OAuth' }));
  await waitFor(() => expect(writes(api, '/management/builtin-plugins/omc-zcode-oauth/policy')).toHaveLength(1));
  expect(writes(api, '/management/builtin-plugins/omc-zcode-oauth/policy')[0].body).toEqual({ enabled: false, revision: 4 });
  expect(await screen.findByText(message)).toBeTruthy();
  await waitFor(() => expect(reads(api)).toBe(2));
  expect(writes(api, '/management/builtin-plugins/omc-zcode-oauth/policy')).toHaveLength(1);
});

it('shows unavailable release discovery and an unknown reason as plain text', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/builtin-plugins', () => builtins({
    catalog: { status: 'unavailable', revision: '' },
    plugins: [{ ...ZCODE, status: 'blocked', reason: '<b>new_reason</b>' }],
  }));
  renderWithOmc(<PluginsPage />, { route: '/plugins/builtins' });

  expect(await screen.findByText('Could not check for plugin updates')).toBeTruthy();
  expect(screen.getByText('Unavailable')).toBeTruthy();
  const reason = screen.getByText('<b>new_reason</b>');
  expect(reason.querySelector('b')).toBeNull();
  expect(screen.getByText('Signs in to ZCode.')).toBeTruthy();
});

it('keeps built-in plugins out of the installed list and only counts them there', async () => {
  const api = installOmcApi({ plugins: [
    { id: 'omc-zcode-oauth', source_kind: 'builtin', configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [] },
    { id: 'limiter', source_kind: 'community', configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [] },
  ] });
  api.on('GET', '/management/builtin-plugins', () => builtins());
  renderWithOmc(<PluginsPage />, { route: '/plugins' });

  expect(await screen.findByText('limiter')).toBeTruthy();
  expect(screen.queryByText('ZCode OAuth')).toBeNull();
  expect(screen.queryByText('omc-zcode-oauth')).toBeNull();
  expect(screen.getByText('1 built-in plugin is kept by OMC and listed on the Built-in plugins page.')).toBeTruthy();
  expect(api.requests.some((request) => request.path === '/management/builtin-plugins')).toBe(false);
});

function storeEntry(overrides: Partial<StorePluginItem>): StorePluginItem {
  return {
    store_id: 'mirror:x', source_id: 'mirror', source_name: 'mirror.example', source_kind: 'community', id: 'x', name: 'X', tags: [], platforms: [],
    is_official: false, is_official_repository: false, is_omc: false, auth_required: false, auth_configured: false, installed: false,
    effective_enabled: false, update_available: false, ...overrides,
  };
}

const OFFICIAL_SOURCES = [
  { id: 'official', name: 'Official', url: 'https://o', is_official: true, source_kind: 'official' as const },
  { id: 'builtin', name: 'Oh My CPA', url: 'https://b', is_official: false, source_kind: 'builtin' as const },
  { id: 'omc', name: 'OMC Community', url: 'https://c', is_official: false, source_kind: 'omc_community' as const },
  { id: 'mirror', name: 'mirror.example', url: 'https://m', is_official: false, source_kind: 'community' as const },
];

function officialStore(plugins: StorePluginItem[]): PluginStoreResponse {
  return { plugins_enabled: true, plugins_dir: 'plugins', total: plugins.length, source_errors: [], sources: OFFICIAL_SOURCES, plugins };
}

function omcRegistry(plugins: StorePluginItem[], overrides: Partial<OmcCommunityPluginsResponse> = {}): OmcCommunityPluginsResponse {
  return {
    plugins_enabled: true, plugins_dir: 'plugins', total: plugins.length, source_errors: [], source_enabled: true, source_id: 'omc',
    sources: [OFFICIAL_SOURCES[2]], plugins, ...overrides,
  };
}

const officialEntry = (overrides: Partial<StorePluginItem>) => storeEntry({
  store_id: 'official:x', source_id: 'official', source_name: 'official', source_kind: 'official', is_official: true, is_official_repository: true, ...overrides,
});
const omcEntry = (overrides: Partial<StorePluginItem>) => storeEntry({
  store_id: 'omc:x', source_id: 'omc', source_name: 'OMC Community', source_kind: 'omc_community', ...overrides,
});

function section(key: string) {
  return document.querySelector(`[data-store-source="${key}"]`) as HTMLElement;
}

it('shows CPA\'s official registry and the OMC registry together, each read on its own', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/plugin-store', () => officialStore([officialEntry({ store_id: 'official:limiter', id: 'limiter', name: 'Limiter' })]));
  api.on('GET', '/management/omc-community-plugins', () => omcRegistry([omcEntry({ store_id: 'omc:candy', id: 'candy', name: 'Candy', description_i18n: { en: 'Adapted.' } })]));
  renderWithOmc(<PluginsPage />, { route: '/plugins/store' });

  expect(await within(await waitFor(() => section('official'))).findByText('Limiter')).toBeTruthy();
  const omc = await within(section('omc')).findByText('Candy');
  expect(omc.closest('article')!.getAttribute('data-store-origin')).toBe('omc-community');
  expect(within(section('omc')).getByText('Adapted.')).toBeTruthy();
  expect(api.requests.find((request) => request.path === '/management/plugin-store')?.query.get('source_id')).toBe('official');

  // The operator's own registry stays reachable; neither Oh My CPA catalog is a CPA source.
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Plugin source' }));
  await screen.findAllByRole('option');
  const options = [...document.querySelectorAll('.ant-select-item-option-content')].map((option) => option.textContent);
  expect(options).toEqual(['All sources', 'CLIProxyAPI official', 'OMC plugin registry', 'mirror.example']);
});

it('keeps one registry\'s cards when the other cannot be read or is switched off', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/plugin-store', () => json({ error: 'unreachable' }, 502));
  api.on('GET', '/management/omc-community-plugins', () => omcRegistry([omcEntry({ store_id: 'omc:candy', id: 'candy', name: 'Candy' })]));
  const first = renderWithOmc(<PluginsPage />, { route: '/plugins/store' });
  expect(await within(await waitFor(() => section('omc'))).findByText('Candy')).toBeTruthy();
  expect(await within(section('official')).findByText('unreachable')).toBeTruthy();
  first.unmount();

  // A switched-off read asks CPA nothing, so it cannot say whether the plugin system is on.
  const second = installOmcApi();
  second.on('GET', '/management/plugin-store', () => officialStore([officialEntry({ store_id: 'official:limiter', id: 'limiter', name: 'Limiter' })]));
  second.on('GET', '/management/omc-community-plugins', () => {
    const { plugins_enabled: _unknown, ...off } = omcRegistry([], { source_enabled: false });
    return off;
  });
  renderWithOmc(<PluginsPage />, { route: '/plugins/store' });
  expect(await within(await waitFor(() => section('omc'))).findByText('The OMC plugin registry is off')).toBeTruthy();
  expect(await within(section('official')).findByText('Limiter')).toBeTruthy();
  expect(screen.queryByText('The plugin system is off')).toBeNull();
  expect(second.requests.every((request) => request.method === 'GET')).toBe(true);
});

it('keeps a plugin id listed by both registries as two cards, each installing from its own', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/plugin-store', () => officialStore([officialEntry({ store_id: 'official:dup', id: 'dup', name: 'Dup', description: 'official text' })]));
  api.on('GET', '/management/omc-community-plugins', () => omcRegistry([omcEntry({ store_id: 'omc:dup', id: 'dup', name: 'Dup', description: 'omc text' })]));
  api.on('POST', '/management/plugin-store/dup/install', () => ({ status: 'ok', id: 'dup', version: '1.0.0', plugins_enabled: true, restart_required: false }));
  renderWithOmc(<PluginsPage />, { route: '/plugins/store' });

  const omcCard = (await within(await waitFor(() => section('omc'))).findByText('omc text')).closest('article') as HTMLElement;
  const officialCard = (await within(section('official')).findByText('official text')).closest('article') as HTMLElement;
  expect(omcCard).not.toBe(officialCard);
  expect(within(omcCard).queryByText('official text')).toBeNull();

  fireEvent.click(within(omcCard).getByRole('button', { name: /Install/ }));
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Install' }) as HTMLButtonElement;
  // An OMC registry plugin is third-party code: its id has to be typed.
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(dialog).getByPlaceholderText('dup'), { target: { value: 'dup' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(api.requests.some((request) => request.method === 'POST')).toBe(true));
  expect(api.requests.find((request) => request.method === 'POST')!.body).toEqual({ source_id: 'omc' });
});
