import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { useUsageEventViewState } from '../src/components/usage/useUsageEventViewState';
import { useOAuthManagementViewState } from '../src/pages/oauthManagement/useOAuthManagementViewState';
import { parseOAuthManagementView } from '../src/pages/oauthManagement/oauthWorkspaceLogic';

let api: OmcApi;
const writes = () => api.preferenceWrites();
const refuseWrites = () => api.on('PUT', /^\/preferences\//, () => json({ error: 'write_busy' }, 503));

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

const mount = (children: React.ReactNode, route = '/') => renderWithOmc(children, { route, isStrict: true });

function readView() {
  return JSON.parse(screen.getByLabelText('view').textContent!);
}

beforeEach(() => {
  api = installOmcApi();
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
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    first.unmount();
    const second = mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' }));
    expect(writes()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'all', quota: 'all', sort: 'name-asc' });
    second.unmount();
    mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'all', sort: 'name-asc' }));
  });

  it('honors explicit OAuth link dimensions without saving navigation or one-shot intent', async () => {
    api.state.preferences.oauth_management_view_v1 = { pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' };
    mount(<OAuthView />, '/?status=all&sort=name-desc&page=2&action=connect&connect_provider=codex');
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'attention', sort: 'name-desc', page: 2, action: 'connect' }));
    expect(writes()).toHaveLength(0);
  });

  it('enables URL-only OAuth controls after a failed read without overwriting unread preferences', async () => {
    const unreadPreference = { pageSize: 48, status: 'disabled', quota: 'all', sort: 'name-desc' };
    api.state.preferences.oauth_management_view_v1 = unreadPreference;
    const read = api.hold('GET', '/preferences');
    mount(<OAuthView />);
    const filterButton = screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement;
    expect(filterButton.disabled).toBe(true);
    await act(async () => { read.release(json({ error: 'read_unavailable' }, 503)); });
    await waitFor(() => expect(filterButton.disabled).toBe(false));
    fireEvent.click(filterButton);
    expect(readView()).toMatchObject({ status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    expect(readView().pageSize).toBe(24);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    expect(readView()).toMatchObject({ status: 'all', quota: 'all', sort: 'name-asc', pageSize: 24 });
    expect(writes()).toHaveLength(0);
    expect(api.state.preferences.oauth_management_view_v1).toEqual(unreadPreference);
  });

  it('rolls OAuth controls back when a save fails instead of retaining an unsaved URL override', async () => {
    api.state.preferences.oauth_management_view_v1 = { pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' };
    mount(<OAuthView />, '/?sort=weight-desc');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement).disabled).toBe(false));
    refuseWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Filter OAuth' }));
    await screen.findByText('write_busy');
    await waitFor(() => expect(readView()).toMatchObject({ status: 'disabled', quota: 'all', sort: 'weight-desc' }));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' });
  });

  for (const route of ['/', '/?preset=24h&model=linked-model']) {
    it(`restores request grouping, refresh and advanced filters after remount from ${route}`, async () => {
      const first = mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh requests' }));
      await waitFor(() => expect(writes()).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Filter requests' }));
      await waitFor(() => expect(writes()).toHaveLength(3));
      first.unmount();
      mount(<RequestView />);
      await waitFor(() => expect(readView()).toMatchObject({ grouping: 'source', autoRefresh: true, query: { filters: { auth_type: ['oauth'] }, ranges: { latency: { min: 300 } } } }));
      expect(writes()).toHaveLength(3);
    });

    it(`rolls request grouping and refresh back after refused saves from ${route}`, async () => {
      mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      await act(async () => { await Promise.resolve(); });
      refuseWrites();
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await screen.findByText('write_busy');
      await waitFor(() => expect(readView().grouping).toBe('time'));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh requests' }));
      await waitFor(() => expect(writes()).toHaveLength(2));
      await waitFor(() => expect(readView().autoRefresh).toBe(false));
      if (route !== '/') expect(readView().query).toMatchObject({ preset: '24h', filters: { model: ['linked-model'] } });
    });
  }
});
