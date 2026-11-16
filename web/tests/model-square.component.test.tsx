import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { QUERY_KEYS } from '../src/api/queryKeys';
import { reconcileStateSyncEvent } from '../src/hooks/useEventSource';
import { ModelSquarePage } from '../src/pages/ModelSquarePage';
import { ModelMark } from '../src/components/ModelMark';
import { MODEL_ICONS_PREFERENCE } from '../src/types/modelIcons';
import type { ModelSquareDirectory } from '../src/types/modelSquare';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

const CUSTOM = 'custom:0123456789abcdef0123456789abcdef';
const DIRECTORY: ModelSquareDirectory = {
  models: ['gpt-5', 'mystery-x'].map(id => ({ id, call_point: id, vision: 'unknown' })),
  model_info: {},
  providers: [],
  partial: [],
  routes: [],
};

beforeEach(() => {
  // jsdom has no IntersectionObserver; the picker only uses it to defer artwork requests.
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});

function renderPage(preferences: Record<string, unknown> = {}, directory = DIRECTORY, client = createTestQueryClient()): OmcApi {
  const api = installOmcApi({ preferences });
  api.on('GET', '/management/model-square', () => directory);
  api.on('GET', '/pricing', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/usage/facets', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/custom-icons', () => ({ icons: [] }));
  renderWithOmc(<ModelSquarePage />, { route: '/model-square', client });
  return api;
}

const iconTile = async (model: string) => {
  await screen.findByText(model);
  return document.querySelector<HTMLButtonElement>(`[data-model-icon="${model}"]`)!;
};

it('picks a model icon from the card without opening the details, and keeps the picker open when the save fails', async () => {
  const api = renderPage({ [MODEL_ICONS_PREFERENCE]: { 'mystery-x': 'Gemini' } });
  const tile = await iconTile('gpt-5');
  expect(tile.getAttribute('aria-label')).toBe('Change icon for gpt-5');

  api.on('PUT', `/preferences/${MODEL_ICONS_PREFERENCE}`, () => json({ error: 'write_failed' }, 500));
  fireEvent.click(tile);
  const dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  expect(within(dialog).queryByTestId('icon-picker-reset')).toBeNull();
  fireEvent.click(dialog.querySelector('[data-icon-id="Claude"]')!);
  await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
  expect(screen.getByRole('dialog', { name: 'Select Model Icon' })).toBeTruthy();

  api.on('PUT', `/preferences/${MODEL_ICONS_PREFERENCE}`, (request, state) => {
    state.preferences[MODEL_ICONS_PREFERENCE] = request.body;
    return { key: MODEL_ICONS_PREFERENCE, value: request.body };
  });
  fireEvent.click(dialog.querySelector('[data-icon-id="Claude"]')!);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select Model Icon' })).toBeNull());
  // The write merges into the stored document rather than replacing another model's choice.
  expect(api.preferenceWrites().at(-1)?.value).toEqual({ 'mystery-x': 'Gemini', 'gpt-5': 'Claude' });
  expect(document.querySelector('[data-slot="sheet-title"]')).toBeNull();
});

it('changes and resets the icon from the details drawer', async () => {
  const api = renderPage({ [MODEL_ICONS_PREFERENCE]: { 'gpt-5': CUSTOM, 'mystery-x': 'Gemini' } });
  await iconTile('gpt-5');
  fireEvent.click(screen.getByRole('button', { name: 'View information for gpt-5' }));
  fireEvent.click(await screen.findByTestId('model-profile-icon'));

  const dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  fireEvent.click(within(dialog).getByTestId('icon-picker-reset'));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select Model Icon' })).toBeNull());
  expect(api.preferenceWrites().at(-1)).toEqual({ key: MODEL_ICONS_PREFERENCE, value: { 'mystery-x': 'Gemini' } });
});

it('draws the icon an operator chose for a model wherever the console marks it', async () => {
  installOmcApi({ preferences: { [MODEL_ICONS_PREFERENCE]: { 'team/fast': 'Gemini' } } });
  const { container } = renderWithOmc(<>
    <ModelMark model="team/fast" fallbackModel="gpt-5" size={16} className="chosen" />
    <ModelMark model="gpt-5" size={16} className="maker" />
  </>);
  await waitFor(() => expect(container.querySelector('.chosen img, .chosen svg')?.outerHTML ?? '').toMatch(/gemini/i));
  expect(container.querySelector('.maker img, .maker svg')?.outerHTML ?? '').not.toMatch(/gemini/i);
});

it('an alias with one upstream shows the icon chosen for that upstream but resets only its own', async () => {
  const api = renderPage({ [MODEL_ICONS_PREFERENCE]: { 'gpt-5': 'Gemini' } }, {
    ...DIRECTORY,
    models: [{ id: 'team/fast', call_point: 'team/fast', vision: 'unknown' }],
    routes: [{ provider_id: 'relay', upstream_model: 'gpt-5', call_point: 'team/fast' }],
  });
  api.on('PUT', `/preferences/${MODEL_ICONS_PREFERENCE}`, (request, state) => {
    state.preferences[MODEL_ICONS_PREFERENCE] = request.body;
    return { key: MODEL_ICONS_PREFERENCE, value: request.body };
  });
  const tile = await iconTile('team/fast');
  await waitFor(() => expect(tile.innerHTML).toMatch(/gemini/i));
  fireEvent.click(screen.getByRole('button', { name: 'View information for team/fast' }));
  await waitFor(() => expect(screen.getByTestId('model-profile-icon').innerHTML).toMatch(/gemini/i));

  fireEvent.click(tile);
  let dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  expect(within(dialog).queryByTestId('icon-picker-reset')).toBeNull();
  expect(dialog.querySelector('[data-icon-id="Gemini"]')?.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(dialog.querySelector('[data-icon-id="Claude"]')!);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select Model Icon' })).toBeNull());
  expect(api.preferenceWrites().at(-1)?.value).toEqual({ 'gpt-5': 'Gemini', 'team/fast': 'Claude' });

  fireEvent.click(tile);
  dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  expect(within(dialog).getByTestId('icon-picker-reset')).toBeTruthy();
});

it('gates icon writes until the preferences document has loaded', async () => {
  const api = installOmcApi();
  api.on('GET', '/preferences', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/management/model-square', () => DIRECTORY);
  api.on('GET', '/pricing', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/usage/facets', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/custom-icons', () => ({ icons: [] }));
  renderWithOmc(<ModelSquarePage />, { route: '/model-square' });

  const tile = await iconTile('gpt-5');
  fireEvent.click(tile);
  const dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  fireEvent.click(dialog.querySelector('[data-icon-id="Claude"]')!);
  await act(async () => { await Promise.resolve(); });
  expect(api.preferenceWrites()).toHaveLength(0);
  expect(screen.getByRole('dialog', { name: 'Select Model Icon' })).toBeTruthy();
});

it('cancels an in-flight preferences read before updating model_icons so a late response cannot erase the pick', async () => {
  const client = createTestQueryClient();
  const api = renderPage({ [MODEL_ICONS_PREFERENCE]: { 'gpt-5': 'OpenAI' } }, DIRECTORY, client);
  const tile = await iconTile('mystery-x');

  const staleRead = api.hold('GET', '/preferences');
  void client.invalidateQueries({ queryKey: QUERY_KEYS.preferences });
  await staleRead.arrived;

  fireEvent.click(tile);
  const dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  fireEvent.click(dialog.querySelector('[data-icon-id="Claude"]')!);
  await waitFor(() => expect(api.preferenceWrites()).toHaveLength(1));
  expect(api.preferenceWrites()[0].value).toEqual({ 'gpt-5': 'OpenAI', 'mystery-x': 'Claude' });

  staleRead.release(json({ preferences: { [MODEL_ICONS_PREFERENCE]: { 'gpt-5': 'OpenAI' } }, time_zone: { server_timezone: 'UTC' } }));
  await act(async () => { await Promise.resolve(); });
  expect(client.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.[MODEL_ICONS_PREFERENCE]).toEqual({
    'gpt-5': 'OpenAI',
    'mystery-x': 'Claude',
  });
});

it('reconciles remote model_icons on state_sync while preserving unrelated and pending local preference edits', async () => {
  const client = createTestQueryClient();
  const api = installOmcApi({ preferences: { [MODEL_ICONS_PREFERENCE]: { 'gpt-5': 'OpenAI' }, omc_theme: 'dark' } });
  api.on('GET', '/management/model-square', () => DIRECTORY);
  api.on('GET', '/pricing', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/usage/facets', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/custom-icons', () => ({ icons: [] }));
  renderWithOmc(<><ModelMark model="gpt-5" size={16} className="live-model-mark" /><ModelSquarePage /></>, { route: '/model-square', client });
  const gptTile = await iconTile('gpt-5');
  const mysteryTile = await iconTile('mystery-x');

  // Unrelated local optimistic edit in the shared preferences document survives icon reconciliation.
  client.setQueryData<Record<string, unknown>>(QUERY_KEYS.preferences, (cached) => ({ ...(cached ?? {}), omc_theme: 'light' }));
  api.state.preferences[MODEL_ICONS_PREFERENCE] = { 'gpt-5': 'Claude' };
  const tracker = { lastVersion: 1 };
  await act(async () => {
    await reconcileStateSyncEvent(client, { type: 'state_sync', version: 2, scopes: ['management-identity-directory'] }, tracker);
  });
  await waitFor(() => expect(gptTile.innerHTML).toMatch(/claude/i));
  await waitFor(() => expect(document.querySelector('.live-model-mark')?.innerHTML ?? '').toMatch(/claude/i));
  expect(client.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.omc_theme).toBe('light');

  // A pending local model_icons write is preserved if a remote state_sync arrives before it settles,
  // and deferred reconciliation catches up if that local write fails.
  const pendingPut = api.hold('PUT', `/preferences/${MODEL_ICONS_PREFERENCE}`);
  fireEvent.click(mysteryTile);
  const dialog = await screen.findByRole('dialog', { name: 'Select Model Icon' });
  fireEvent.click(dialog.querySelector('[data-icon-id="Gemini"]')!);
  await pendingPut.arrived;

  api.state.preferences[MODEL_ICONS_PREFERENCE] = { 'gpt-5': 'DeepSeek' };
  await act(async () => {
    await reconcileStateSyncEvent(client, { type: 'state_sync', version: 3, scopes: ['management-identity-directory'] }, tracker);
  });
  expect(client.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.[MODEL_ICONS_PREFERENCE]).toEqual({
    'gpt-5': 'Claude',
    'mystery-x': 'Gemini',
  });

  pendingPut.release(json({ error: 'write_failed' }, 500));
  await waitFor(() => expect(gptTile.innerHTML).toMatch(/deepseek/i));
  expect(client.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.[MODEL_ICONS_PREFERENCE]).toEqual({
    'gpt-5': 'DeepSeek',
  });
});
