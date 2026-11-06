import type { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
