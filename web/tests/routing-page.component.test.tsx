import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RoutingPage } from '../src/pages/routing/RoutingPage';
import type { RoutingBoard, RoutingMember } from '../src/types/routing';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const member = (key: string, name: string, priority: number, kind: RoutingMember['kind'] = 'credential'): RoutingMember => ({
  key, kind, id: key.split(':')[1], family: 'codex', name, priority,
  weights: [{ index: 0, auth_index: `auth-${name}`, weight: null }],
  key_count: 1, is_disabled: false, is_unavailable: false, is_runtime_only: false,
});

const board: RoutingBoard = {
  revision: 'rev-1',
  settings: {
    strategy: 'round-robin', session_affinity: false, session_affinity_ttl: '', request_retry: 2,
    max_retry_credentials: 0, max_retry_interval: 30, disable_cooling: false, transient_error_cooldown_seconds: 0,
    force_model_prefix: false,
  },
  members: [
    member('credential:primary.json', 'Primary seat', 10),
    member('provider:claude-0', 'Anthropic Claude', 0, 'provider'),
    member('credential:backup.json', 'Backup seat', 0),
  ],
  partial: [],
};

function renderRoutingPage() {
  const router = createMemoryRouter([
    { path: '/routing', element: <RoutingPage /> },
    { path: '/elsewhere', element: <h1>Other page</h1> },
  ], { initialEntries: ['/routing'] });
  // jsdom owns the blocker state; the browser probe owns dialog motion and focus.
  return { ...renderWithOmc(<ConfigProvider theme={{ token: { motion: false } }}><AntdApp><RouterProvider router={router} /></AntdApp></ConfigProvider>), router };
}

async function arrangeAndApply(reply: Response | object) {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => board);
  api.on('PATCH', '/management/routing', () => reply);
  renderRoutingPage();

  // The keyboard path: Alt+ArrowUp lifts the backup seat into the primary's tier.
  const card = await screen.findByRole('listitem', { name: 'Backup seat' });
  card.focus();
  fireEvent.keyDown(card, { key: 'ArrowUp', altKey: true });
  await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Tier 1' })).getByRole('listitem', { name: 'Backup seat' })).toBeTruthy());
  fireEvent.click(screen.getByText('Fill first'));

  expect(await screen.findByText('2 changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  return api;
}

it('applies an arrangement as one plan naming only what changed', async () => {
  const api = await arrangeAndApply({ is_complete: true, results: [], board: { ...board, revision: 'rev-2' } });
  expect(await screen.findByText('Routing applied')).toBeTruthy();
  const patches = api.requests.filter((request) => request.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0].body).toEqual({
    revision: 'rev-1',
    settings: { strategy: 'fill-first' },
    members: [{ key: 'credential:backup.json', priority: 10 }],
  });
});

it.each([
  { value: '', expected: 0 },
  { value: '-1', expected: -1 },
])('submits cooldown $expected when the input is "$value"', async ({ value, expected }) => {
  const api = installOmcApi();
  const currentBoard: RoutingBoard = { ...board, settings: { ...board.settings, transient_error_cooldown_seconds: 20 } };
  const updatedBoard: RoutingBoard = { ...currentBoard, revision: 'rev-2', settings: { ...currentBoard.settings, transient_error_cooldown_seconds: expected } };
  api.on('GET', '/management/routing', () => currentBoard);
  api.on('PATCH', '/management/routing', () => ({ is_complete: true, results: [], board: updatedBoard }));
  renderRoutingPage();

  fireEvent.click(await screen.findByRole('button', { name: /^Failover/ }));
  const input = screen.getByRole('spinbutton', { name: 'Transient Error Cooldown' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  expect(input.value).toBe(String(expected));

  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await screen.findByText('Routing applied');
  expect(api.requests.filter(request => request.method === 'PATCH').map(request => request.body)).toEqual([{
    revision: 'rev-1',
    settings: { transient_error_cooldown_seconds: expected },
  }]);
});

it('reports a plan refused for a changed board and offers a reload', async () => {
  await arrangeAndApply(json({ error: 'changed', code: 'routing_conflict' }, 409));
  expect(await screen.findByText('Routing changed elsewhere. Reload and arrange again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});


const savedBoard: RoutingBoard = { ...board, revision: 'rev-2', settings: { ...board.settings, strategy: 'fill-first' } };

async function submitStrategy() {
  fireEvent.click(await screen.findByText('Fill first'));
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
}

it('locks settings, weights and tier actions until the submitted plan has settled', async () => {
  const api = installOmcApi();
  const weightedBoard: RoutingBoard = { ...board, settings: { ...board.settings, strategy: 'weighted-round-robin' } };
  api.on('GET', '/management/routing', () => weightedBoard);
  const held = api.hold('PATCH', '/management/routing');
  renderRoutingPage();
  const card = await screen.findByRole('listitem', { name: 'Backup seat' });
  fireEvent.click(within(card).getByRole('button', { name: 'Weight of Backup seat' }));
  const weight = await screen.findByRole('spinbutton');
  fireEvent.change(weight, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await held.arrived;
  await waitFor(() => expect((screen.getByRole('radio', { name: 'Fill first' }) as HTMLInputElement).disabled).toBe(true));
  expect((screen.getByRole('switch', { name: 'Enable Session Affinity' }) as HTMLButtonElement).disabled).toBe(true);
  expect((weight as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Fill first'));
  fireEvent.keyDown(card, { key: 'ArrowUp', altKey: true });
  expect(within(screen.getByRole('listitem', { name: 'Tier 2' })).getByRole('listitem', { name: 'Backup seat' })).toBeTruthy();
  held.release({
    is_complete: true, results: [],
    board: { ...weightedBoard, revision: 'rev-2', members: weightedBoard.members.map(entry => entry.key === 'credential:backup.json' ? { ...entry, weights: [{ index: 0, weight: 7 }] } : entry) },
  });
  await screen.findByText('Routing applied');
  await waitFor(() => expect((screen.getByRole('radio', { name: 'Fill first' }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByRole('radio', { name: 'Weighted' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText('1 change')).toBeNull();
});

it('adopts the confirmed read after a successful response without a board', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => board);
  api.on('PATCH', '/management/routing', () => ({ is_complete: true, results: [] }));
  renderRoutingPage();
  await screen.findByText('Fill first');
  const readback = api.hold('GET', '/management/routing');
  await submitStrategy();
  await readback.arrived;
  await waitFor(() => expect((screen.getByRole('radio', { name: 'Weighted' }) as HTMLInputElement).disabled).toBe(true));
  readback.release(savedBoard);
  await screen.findByText('Routing applied');
  expect(api.requests.filter(request => request.method === 'GET' && request.path === '/management/routing')).toHaveLength(2);
  await waitFor(() => expect(screen.queryByText('1 change')).toBeNull());
  expect(screen.queryByText('Routing changed elsewhere; reload before applying.')).toBeNull();
});

it('requires a successful reload before applying again when the post-save read fails', async () => {
  const api = installOmcApi();
  let reads = 0;
  api.on('GET', '/management/routing', () => ++reads === 1 ? board : json({error:'unavailable'}, 502));
  api.on('PATCH', '/management/routing', () => ({ is_complete: true, results: [] }));
  renderRoutingPage();
  await submitStrategy();
  await screen.findByText('Routing applied');
  expect((screen.getByRole('button', {name:/Save changes/}) as HTMLButtonElement).disabled).toBe(true);
  api.on('GET', '/management/routing', () => savedBoard);
  fireEvent.click(screen.getByRole('button', {name:'Retry'}));
  await waitFor(() => expect(screen.queryByText('1 change')).toBeNull());
  fireEvent.click(screen.getByText('Weighted'));
  expect((screen.getByRole('button', {name:/Save changes/}) as HTMLButtonElement).disabled).toBe(false);
});

it('protects a draft from route departure and unload until it is explicitly discarded', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => board);
  const {router} = renderRoutingPage();
  fireEvent.click(await screen.findByText('Fill first'));
  const unload = new Event('beforeunload', {cancelable:true});
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(() => router.navigate('/elsewhere'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', {name:'Cancel'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(router.state.location.pathname).toBe('/routing');
  expect((screen.getByRole('radio', {name:'Fill first'}) as HTMLInputElement).checked).toBe(true);
  await act(() => router.navigate('/elsewhere'));
  fireEvent.click(await screen.findByRole('button', {name:'Leave page'}));
  await screen.findByRole('heading', {name:'Other page'});
  const cleanUnload = new Event('beforeunload', {cancelable:true});
  window.dispatchEvent(cleanUnload);
  expect(cleanUnload.defaultPrevented).toBe(false);
});
