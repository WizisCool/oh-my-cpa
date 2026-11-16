import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ModelSquarePage } from '../src/pages/ModelSquarePage';
import { ModelMark } from '../src/components/ModelMark';
import { MODEL_ICONS_PREFERENCE } from '../src/types/modelIcons';
import type { ModelSquareDirectory } from '../src/types/modelSquare';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

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

function renderPage(preferences: Record<string, unknown> = {}, directory = DIRECTORY): OmcApi {
  const api = installOmcApi({ preferences });
  api.on('GET', '/management/model-square', () => directory);
  api.on('GET', '/pricing', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/usage/facets', () => json({ error: 'unavailable' }, 503));
  api.on('GET', '/custom-icons', () => ({ icons: [] }));
  renderWithOmc(<ModelSquarePage />, { route: '/model-square' });
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
