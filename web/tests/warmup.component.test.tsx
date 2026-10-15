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
function mount(children: React.ReactNode, { isSettingsFailing = false } = {}) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fixture = createWarmupFixture();
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    requests.push({ method: options.method ?? 'GET', path, body: options.body ? JSON.parse(options.body as string) : {} });
    if (isSettingsFailing && path.endsWith('/warmup/settings')) return new Response(JSON.stringify({ code: 'warmup_unavailable', error: 'warmup_unavailable' }), { status: 500 });
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
it('reads an inherited policy as plain rules and reports credential-local draft ownership', async () => {
  const onDirtyChange = vi.fn(); const surface = mount(<CredentialWarmup authIndex="exact-claude" onDirtyChange={onDirtyChange} />);
  await screen.findByText('As soon as either window resets');
  expect(screen.getByText('Follows the Claude default in Warmup settings.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  fireEvent.click(screen.getByText('Custom'));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  expect(screen.getByRole('switch', { name: 'Warm up as soon as a window resets' }).getAttribute('aria-checked')).toBe('true');
  expect((screen.getByRole('button', { name: 'Warm up now' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  expect(surface.requests.every(entry => entry.method === 'GET')).toBe(true);
  surface.unmount(); surface.client.clear();
});
it('keeps provider changes disabled while its default draft is unsaved', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText("With a daily time set, the five-hour window starts at that time when possible. If it can't be sent within an hour of that time, that day's daily warmup is skipped.");
  fireEvent.click(screen.getByRole('switch', { name: 'Warm up daily at a set time' }));
  expect(screen.getByText('The five-hour window runs 06:00–11:00 (UTC)')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(surface.requests.every(entry => entry.method === 'GET')).toBe(true);
  surface.unmount(); surface.client.clear();
});

it('leads with what the automation is doing and why it is paused', async () => {
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />);
  const status = await screen.findByTestId('warmup-status');
  expect(within(status).getByText('Automatic warmup is paused')).toBeTruthy();
  expect(within(status).getByText("This credential's quota can't be read right now. Warmup resumes once it can.")).toBeTruthy();
  expect(within(status).getByText("Paid overage isn’t confirmed off yet; no automatic warmup until it is")).toBeTruthy();
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, reason: 'already_active', state: { ...previous.state, observation: { observed_at_ms: 1770000000000, paid_fallback: 'disabled' } } } : previous));
  await within(status).findByText('Automatic warmup is on');
  expect(within(status).getByText('Paid overage is off; only a little subscription quota is used')).toBeTruthy();
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, policy: { ...DEFAULT_WARMUP_POLICY, model: 'claude-haiku-test' } } : previous));
  await within(status).findByText('Automatic warmup is off');
  surface.unmount(); surface.client.clear();
});

it.each(['secure', 'http', 'without-crypto'])('confirms a manual run on %s and keeps its durable result', async origin => {
  if (origin === 'http') vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  if (origin === 'without-crypto') vi.stubGlobal('crypto', undefined);
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />);
  const runButton = await screen.findByRole('button', { name: 'Warm up now' });
  fireEvent.click(runButton);
  const dialog = await screen.findByRole('dialog');
  expect(surface.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  expect(within(dialog).getByText(/claude-haiku-test/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Warm up now' }));
  const notification = await screen.findByRole('status');
  expect(within(notification).getByText('Quota window started')).toBeTruthy();
  expect(screen.getAllByRole('status')).toHaveLength(1);
  const last = await screen.findByTestId('warmup-last-result');
  expect(within(last).getByText('Quota window started')).toBeTruthy();
  expect(within(last).getByText(/Manual/)).toBeTruthy();
  const runs = surface.requests.filter(request => request.method === 'POST');
  expect(runs).toHaveLength(1);
  expect(runs[0].body).toEqual({ confirmed: true, request_id: expect.any(String), revision: 'wire-revision' });
  expect((runs[0].body.request_id as string).length).toBeGreaterThanOrEqual(8);
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous && previous.state.last_result ? { ...previous, state: { ...previous.state, last_result: { ...previous.state.last_result, request_id: 'later-automatic-run', trigger: 'reset', status: 'failed', reason: 'rate_limited' } } } : previous));
  await within(last).findByText('Warmup failed');
  expect(within(last).getByText('The provider refused the request because of rate or quota limits.')).toBeTruthy();
  expect(within(last).queryByText('Quota window started')).toBeNull();
  surface.unmount(); surface.client.clear();
});

it('refuses to save a switch to the default it could not read', async () => {
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />, { isSettingsFailing: true });
  await screen.findByTestId('warmup-status');
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, inherit: false, policy: { ...previous.policy, daily_enabled: true } } : previous));
  await screen.findByRole('switch', { name: 'Warm up daily at a set time' });
  fireEvent.click(screen.getByText('Default'));
  expect((await screen.findAllByText('Could not read warmup settings')).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  surface.unmount(); surface.client.clear();
});

it('names the time zone of an inherited daily rule', async () => {
  const surface = mount(<CredentialWarmup authIndex="exact-claude" />);
  await screen.findByTestId('warmup-status');
  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous ? { ...previous, timezone: 'Asia/Kuala_Lumpur', policy: { ...previous.policy, daily_enabled: true } } : previous));
  await screen.findByText('Daily at 06:00 (Asia/Kuala_Lumpur)');
  surface.unmount(); surface.client.clear();
});
