import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { CredentialWarmup, WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupPolicy, DEFAULT_WARMUP_POLICY, type WarmupCredential } from '../src/types/warmup';

beforeEach(() => { window.localStorage.setItem('omc-lang', 'en');
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
 vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});
function mount(children: React.ReactNode) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fixture = createWarmupFixture();
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    requests.push({ method: options.method ?? 'GET', path, body: options.body ? JSON.parse(options.body as string) : {} });
    const result = fixture(new URL(path, 'http://127.0.0.1'), options.method ?? 'GET', options.body as string);
    return new Response(JSON.stringify('json' in result ? result.json : result), { status: 'status' in result ? result.status : 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const surface = render(<React.StrictMode><App><QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider></App></React.StrictMode>);
  return { requests, client, ...surface };
}
it('uses safe defaults and requires a model before automatic activation', () => {
  expect(DEFAULT_WARMUP_POLICY.daily_time).toBe('06:00');
  expect(canSaveWarmupPolicy(DEFAULT_WARMUP_POLICY)).toBe(true);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_enabled: true })).toBe(false);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_enabled: true, model: 'haiku' })).toBe(true);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_time: '24:00' })).toBe(false);
});
it('reads inherited policy without writing and reports credential-local draft ownership', async () => {
  const onDirtyChange = vi.fn(); const surface = mount(<CredentialWarmup authIndex="exact-claude" onDirtyChange={onDirtyChange} />);
  await screen.findByText('Inherit provider default');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Policy source' }));
  fireEvent.click(await screen.findByText('Credential override'));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  expect((screen.getByRole('button', { name: 'Warm up now' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  expect(surface.requests.every(entry => entry.method === 'GET')).toBe(true);
  surface.unmount(); surface.client.clear();
});
it('keeps provider changes disabled while its default draft is unsaved', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText('Daily time takes priority: wait if a new five-hour window would overlap the next daily start. Missed starts are only caught up within one hour.');
  expect(screen.queryByText(/First select a model and run Warm up now/)).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: 'Daily scheduled warmup' }));
  expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(surface.requests.every(entry => entry.method === 'GET')).toBe(true);
  surface.unmount(); surface.client.clear();
});

it('shows activation observations and billing evidence independently of automatic readiness', async () => {
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />);
  await screen.findByText('Activation observation');
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, reason: undefined } : previous));
  expect(screen.getByText('Not observed for this model')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Warm up now' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('Paid fallback')).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, state: { ...previous.state, protocol_verified: true, verified_model: previous.policy.model, observation: { observed_at_ms: 1770000000000, paid_fallback: 'disabled' } } } : previous));
  await screen.findByText('Observed for this model');
  expect(screen.getByText('Disabled')).toBeTruthy();
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, policy: { ...previous.policy, model: 'a-different-model' } } : previous));
  await screen.findByText('Not observed for this model');
  surface.unmount(); surface.client.clear();
});

it('reports a completed manual run once in the durable credential section', async () => {
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />);
  const runButton = await screen.findByRole('button', { name: 'Warm up now' });
  fireEvent.click(runButton);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Warm up now' }));
  await screen.findByText('Window activation confirmed');
  expect(screen.getAllByText('Window activation confirmed')).toHaveLength(1);
  expect(surface.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous && previous.state.last_result ? { ...previous, state: { ...previous.state, last_result: { ...previous.state.last_result, request_id: 'later-automatic-run', started_at_ms: previous.state.last_result.started_at_ms + 1, status: 'failed', reason: 'rate_limited' } } } : previous));
  await screen.findByText('Warmup failed');
  expect(screen.queryByText('Window activation confirmed')).toBeNull();
  surface.unmount(); surface.client.clear();
});
