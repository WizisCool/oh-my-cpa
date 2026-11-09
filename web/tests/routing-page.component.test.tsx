import type { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RoutingPage } from '../src/pages/routing/RoutingPage';
import type { RoutingBoard, RoutingMember } from '../src/types/routing';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
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

function renderRoutingPage(client?: QueryClient) {
  const router = createMemoryRouter([
    { path: '/routing', element: <RoutingPage /> },
    { path: '/elsewhere', element: <h1>Other page</h1> },
  ], { initialEntries: ['/routing'] });
  return { ...renderWithOmc(<ConfigProvider theme={{ token: { motion: false } }}><AntdApp><RouterProvider router={router} /></AntdApp></ConfigProvider>, { client }), router };
}

async function arrangeAndApply(reply: Response | object) {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => board);
  api.on('PATCH', '/management/routing', () => reply);
  renderRoutingPage();

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

it('reports a plan refused for a changed board and offers a reload', async () => {
  await arrangeAndApply(json({ error: 'changed', code: 'routing_conflict' }, 409));
  expect(await screen.findByText('Routing changed elsewhere. Reload and arrange again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

it('steps a weight from its chip only while its editor is open', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => ({
    ...board,
    settings: { ...board.settings, strategy: 'weighted-round-robin' },
  }));
  renderRoutingPage();

  // One key, so the card carries one weight, and its editor is closed.
  const chip = await screen.findByRole('button', { name: 'Weight of Primary seat' });
  expect(chip.textContent).toBe('×1');

  // A wheel crossing the board belongs to its scroll: a routing weight does not change under a
  // reader who never opened it.
  fireEvent.wheel(chip, { deltaY: -100 });
  expect(chip.textContent).toBe('×1');

  fireEvent.click(chip);
  fireEvent.wheel(chip, { deltaY: -100 });
  expect(chip.textContent).toBe('×2');
});

const authFile = (name: string, email: string, displayName?: string): ManagementAuthFile => ({
  name, email, display_name: displayName, type: 'zcode', provider: 'zcode',
  disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0,
});

it('masks an account a credential is named after and reveals it on click', async () => {
  const account = 'operator@example.com';
  const api = installOmcApi({
    authFiles: [
      { file: authFile('zcode-acct.json', account), fields: {} },
      { file: authFile('zcode-named.json', account, 'Team seat'), fields: {} },
    ],
  });
  api.on('GET', '/management/routing', () => ({
    ...board,
    members: [
      { ...member('credential:zcode-acct.json', account, 10), family: 'zcode' },
      { ...member('credential:zcode-named.json', 'Team seat', 0), family: 'zcode' },
      member('provider:claude-0', 'Anthropic Claude', 0, 'provider'),
    ],
  }));
  renderRoutingPage();

  const card = await screen.findByRole('listitem', { name: 'op•••r@example.com' });
  expect(screen.queryByText(account)).toBeNull();

  fireEvent.click(within(card).getByText('op•••r@example.com'));
  expect(within(card).getByText(account)).toBeTruthy();
  // Revealing the card's text does not republish the name in the card's accessible name.
  expect(screen.getByRole('listitem', { name: 'op•••r@example.com' })).toBeTruthy();

  // The operator's own name for a credential is not identity material, so it stays whole and is no toggle.
  const named = screen.getByRole('listitem', { name: 'Team seat' });
  expect(within(named).queryByTitle('Show account')).toBeNull();
});

it('opens the failover disclosure after a translator rewrote the toggle text', async () => {
  const api = installOmcApi();
  api.on('GET', '/management/routing', () => board);
  renderRoutingPage();

  const toggle = await screen.findByRole('button', { name: /Failover/ });
  // Chrome Translate replaces each text node with a <font> that holds the translation, while React
  // still refers to the original node when it swaps the chevron icon in front of it.
  const walker = document.createTreeWalker(toggle, NodeFilter.SHOW_TEXT);
  let text: Node | null = null;
  while (walker.nextNode()) if (walker.currentNode.textContent === 'Failover') text = walker.currentNode;
  expect(text).toBeTruthy();
  const font = document.createElement('font');
  text!.parentNode!.replaceChild(font, text!);
  font.appendChild(text!);

  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByLabelText('Request Retries')).toBeTruthy();
});
