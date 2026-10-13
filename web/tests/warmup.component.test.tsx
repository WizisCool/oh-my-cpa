import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { CredentialWarmup, WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupPolicy, DEFAULT_WARMUP_POLICY } from '../src/types/warmup';

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
  fireEvent.click(screen.getByRole('switch', { name: 'Daily scheduled warmup' }));
  expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(surface.requests.every(entry => entry.method === 'GET')).toBe(true);
  surface.unmount(); surface.client.clear();
});
