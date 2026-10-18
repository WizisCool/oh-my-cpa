import React from 'react';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { useUsageEventViewState } from '../src/components/usage/useUsageEventViewState';
import { useOAuthManagementViewState } from '../src/pages/oauthManagement/useOAuthManagementViewState';
import { parseOAuthManagementView } from '../src/pages/oauthManagement/oauthWorkspaceLogic';

let stored: Record<string, unknown>;
let writes: { key: string; value: unknown }[];
let shouldRejectWrite: boolean;
let readResponse: Promise<Response> | undefined;
const clients: QueryClient[] = [];

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function OAuthView() {
  const { queryState, setSearch, isViewLoaded } = useOAuthManagementViewState();
  return <>
    <output aria-label="view">{JSON.stringify(queryState)}</output>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ status: 'enabled', quota: 'attention', sort: 'priority-desc', page: null })}>Filter OAuth</button>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ page_size: 24, page: null })}>Resize OAuth</button>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ q: null, status: null, quota: null, sort: null, page: null })}>Reset OAuth</button>
  </>;
}

function RequestView() {
  const view = useUsageEventViewState();
  return <>
    <output aria-label="view">{JSON.stringify({ grouping: view.grouping, autoRefresh: view.isAutoRefresh, query: view.query })}</output>
    <button disabled={!view.isEnabled} onClick={() => view.changeGrouping('source')}>Group requests</button>
    <button disabled={!view.isEnabled} onClick={() => view.toggleAutoRefresh(true)}>Refresh requests</button>
    <button disabled={!view.isEnabled} onClick={() => view.commit({ auth_type: ['oauth'], latency_min: ['300'] })}>Filter requests</button>
  </>;
}

function mount(children: React.ReactNode, route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return render(<React.StrictMode><QueryClientProvider client={client}>
    <I18nProvider><AntdApp><MemoryRouter initialEntries={[route]}>{children}</MemoryRouter></AntdApp></I18nProvider>
  </QueryClientProvider></React.StrictMode>);
}

function readView() {
  return JSON.parse(screen.getByLabelText('view').textContent!);
}

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  stored = {};
  writes = [];
  shouldRejectWrite = false;
  readResponse = undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input === '/omc/api/v1/preferences' && options.method === 'GET') {
      return readResponse ?? jsonResponse({ preferences: stored, time_zone: { server_timezone: 'UTC' } });
    }
    if (input.startsWith('/omc/api/v1/preferences/') && options.method === 'PUT') {
      const key = input.split('/').pop()!;
      const value: unknown = JSON.parse(String(options.body));
      writes.push({ key, value });
      if (shouldRejectWrite) return jsonResponse({ error: 'write_busy' }, 503);
      stored[key] = value;
      return jsonResponse({ key, value });
    }
    throw new Error(`Unexpected component request: ${options.method} ${input}`);
  }));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('list view preference persistence', () => {
  it('preserves old OAuth page sizes and normalizes unknown filter values', () => {
    expect(parseOAuthManagementView({ pageSize: 48, density: 'expanded' })).toEqual({ pageSize: 48, status: 'all', quota: 'all', sort: 'name-asc' });
    expect(parseOAuthManagementView({ pageSize: '24', status: 'bogus', quota: 'bogus', sort: 'bogus' })).toEqual({ pageSize: 12, status: 'all', quota: 'all', sort: 'name-asc' });
  });

  it('saves OAuth filters and sorting with page size, restores them with a fresh cache and persists reset', async () => {
    const first = mount(<OAuthView />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Filter OAuth' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(stored.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    first.unmount();
    const second = mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' }));
    expect(writes).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(stored.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'all', quota: 'all', sort: 'name-asc' });
    second.unmount();
    mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'all', sort: 'name-asc' }));
  });

  it('honors explicit OAuth link dimensions without saving navigation or one-shot intent', async () => {
    stored.oauth_management_view_v1 = { pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' };
    mount(<OAuthView />, '/?status=all&sort=name-desc&page=2&action=connect&connect_provider=codex');
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'attention', sort: 'name-desc', page: 2, action: 'connect' }));
    expect(writes).toHaveLength(0);
  });

  it('enables URL-only OAuth controls after a failed read without overwriting unread preferences', async () => {
    const unreadPreference = { pageSize: 48, status: 'disabled', quota: 'all', sort: 'name-desc' };
    stored.oauth_management_view_v1 = unreadPreference;
    let resolveRead!: (response: Response) => void;
    readResponse = new Promise<Response>((resolve) => { resolveRead = resolve; });
    mount(<OAuthView />);
    const filterButton = screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement;
    expect(filterButton.disabled).toBe(true);
    await act(async () => { resolveRead(jsonResponse({ error: 'read_unavailable' }, 503)); });
    await waitFor(() => expect(filterButton.disabled).toBe(false));
    fireEvent.click(filterButton);
    expect(readView()).toMatchObject({ status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    expect(readView().pageSize).toBe(24);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    expect(readView()).toMatchObject({ status: 'all', quota: 'all', sort: 'name-asc', pageSize: 24 });
    expect(writes).toHaveLength(0);
    expect(stored.oauth_management_view_v1).toEqual(unreadPreference);
  });

  it('rolls OAuth controls back when a save fails instead of retaining an unsaved URL override', async () => {
    stored.oauth_management_view_v1 = { pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' };
    mount(<OAuthView />, '/?sort=requests-desc');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement).disabled).toBe(false));
    shouldRejectWrite = true;
    fireEvent.click(screen.getByRole('button', { name: 'Filter OAuth' }));
    await screen.findByText('write_busy');
    await waitFor(() => expect(readView()).toMatchObject({ status: 'disabled', quota: 'all', sort: 'requests-desc' }));
    expect(stored.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' });
  });

  for (const route of ['/', '/?preset=24h&model=linked-model']) {
    it(`restores request grouping, refresh and advanced filters after remount from ${route}`, async () => {
      const first = mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await waitFor(() => expect(writes).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh requests' }));
      await waitFor(() => expect(writes).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Filter requests' }));
      await waitFor(() => expect(writes).toHaveLength(3));
      first.unmount();
      mount(<RequestView />);
      await waitFor(() => expect(readView()).toMatchObject({ grouping: 'source', autoRefresh: true, query: { filters: { auth_type: ['oauth'] }, ranges: { latency: { min: 300 } } } }));
      expect(writes).toHaveLength(3);
    });

    it(`rolls request grouping and refresh back after refused saves from ${route}`, async () => {
      mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      await act(async () => { await Promise.resolve(); });
      shouldRejectWrite = true;
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await screen.findByText('write_busy');
      await waitFor(() => expect(readView().grouping).toBe('time'));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh requests' }));
      await waitFor(() => expect(writes).toHaveLength(2));
      await waitFor(() => expect(readView().autoRefresh).toBe(false));
      if (route !== '/') expect(readView().query).toMatchObject({ preset: '24h', filters: { model: ['linked-model'] } });
    });
  }
});
