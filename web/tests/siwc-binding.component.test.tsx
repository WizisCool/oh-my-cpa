import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { api } from '../src/api/client';
import { SIWCBindingPanel } from '../src/components/authFiles/SIWCBindingPanel';
import { useSIWCBindings } from '../src/hooks/useSIWCBindings';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';

const FILE: ManagementAuthFile = { name: 'codex.json', auth_index: 'idx-1', provider: 'codex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, siwc_bind_supported: true, use_siwc: false, siwc_bound: false };
const OTHER: ManagementAuthFile = { ...FILE, name: 'other.json', auth_index: 'idx-2' };
const CALLBACK = 'http://127.0.0.1:1455/auth/callback?state=state-idx-1&code=SYNTHETIC-CODE&client_id=issued&extra=a%2Bb';

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});
afterEach(() => { vi.useRealTimers(); });

function mount(file = FILE) {
  const requests: { path: string; method?: string; body: Record<string, unknown>; state: string | null }[] = [];
  let status: object = { status: 'wait' };
  let callbackStatus = 200;
  let readStatus = 200;
  let isCancelled = false;
  let resolveRead: ((response: Response) => void) | undefined;
  let shouldHoldRead = false;
  vi.stubGlobal('fetch', async (input: string, options: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const body = JSON.parse((options.body as string) || '{}');
    requests.push({ path: url.pathname, method: options.method, body, state: url.searchParams.get('state') });
    let result: object;
    let code = 200;
    if (url.pathname.endsWith('/siwc/bind')) result = { url: 'https://auth.openai.com/api/accounts/authorize', state: `state-${body.auth_index}`, flow: 'siwc_bind', expires_in: 300 };
    else if (url.pathname.endsWith('/siwc/status')) {
      if (shouldHoldRead) return new Promise<Response>((resolve) => { resolveRead = resolve; });
      result = status; code = readStatus;
    } else if (url.pathname.endsWith('/siwc/callback')) { result = { status: 'ok' }; code = callbackStatus; }
    else if (url.pathname.endsWith('/siwc/session')) result = { cancelled: isCancelled };
    else throw new Error(`Unexpected request: ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: code });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const bindings = useSIWCBindings();
    const [selected, setSelected] = React.useState<ManagementAuthFile | null>(file);
    return <>
      <button onClick={() => setSelected(FILE)}>First credential</button>
      <button onClick={() => setSelected(OTHER)}>Other credential</button>
      <button onClick={() => setSelected(null)}>Close detail</button>
      {selected && <SIWCBindingPanel file={selected} canEdit bindings={bindings} />}
    </>;
  }
  const surface = render(<App><QueryClientProvider client={client}><I18nProvider><Harness /></I18nProvider></QueryClientProvider></App>);
  return {
    ...surface, requests,
    setStatus: (value: object) => { status = value; },
    setCallbackStatus: (value: number) => { callbackStatus = value; },
    setReadStatus: (value: number) => { readStatus = value; },
    allowCancel: () => { isCancelled = true; },
    holdRead: () => { shouldHoldRead = true; },
    releaseRead: (value: object) => { shouldHoldRead = false; resolveRead?.(new Response(JSON.stringify(value), { status: 200 })); },
    dispose: () => { surface.unmount(); client.clear(); },
  };
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
async function submitCallback(callbackUrl = CALLBACK) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Complete callback URL' }), { target: { value: callbackUrl } });
  await click('Submit callback URL');
}

it('does not start unsupported credentials or present SIWC for another provider', () => {
  const unsupported = mount({ ...FILE, siwc_bind_supported: undefined });
  expect((screen.getByRole('button', { name: 'Bind SIWC' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Unsupported')).toBeTruthy();
  expect(unsupported.requests).toEqual([]);
  unsupported.dispose();
  const other = mount({ ...FILE, provider: 'claude' });
  expect(screen.queryByTestId('siwc-binding')).toBeNull();
  other.dispose();
});

it('preserves the full callback and waits for completed credential readback before success', async () => {
  vi.useFakeTimers();
  const surface = mount();
  try {
    await click('Bind SIWC');
    expect(surface.requests[0].body).toEqual({ name: FILE.name, auth_index: FILE.auth_index, rebind: false });
    surface.setStatus({ status: 'wait', completed: true });
    await submitCallback();
    expect(surface.requests.find((request) => request.path.endsWith('/callback'))?.body).toEqual({ redirect_url: CALLBACK });
    expect(screen.getByText(/CPA completed binding/)).toBeTruthy();
    expect(screen.queryByText('SIWC bound; credential summary confirmed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bind SIWC' })).toBeNull();
    surface.setStatus({ status: 'ok', completed: true, file: { ...FILE, siwc_bound: true, use_siwc: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('SIWC bound; credential summary confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rebind SIWC' })).toBeTruthy();
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  } finally { surface.dispose(); }
});

it.each([
  ['leading whitespace', ` \t${CALLBACK}`],
  ['trailing whitespace', `${CALLBACK}\r\n `],
  ['surrounding whitespace', ` \t${CALLBACK}\r\n `],
])('trims %s without changing callback parameters', async (_label, callbackUrl) => {
  const surface = mount();
  try {
    await click('Bind SIWC');
    await submitCallback(callbackUrl);
    const callback = surface.requests.find((request) => request.path.endsWith('/callback'));
    expect(callback?.state).toBe('state-idx-1');
    expect(callback?.body).toEqual({ redirect_url: CALLBACK });
  } finally { surface.dispose(); }
});

it('keeps attempts scoped to the target across close, reopen and another Codex credential', async () => {
  const surface = mount();
  try {
    await click('Bind SIWC');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: CALLBACK } });
    await click('Close detail');
    await click('Other credential');
    await click('Bind SIWC');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    await click('First credential');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(CALLBACK);
    await click('Submit callback URL');
    const callbacks = surface.requests.filter((request) => request.path.endsWith('/callback'));
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].state).toBe('state-idx-1');
    expect(surface.requests.filter((request) => request.path.endsWith('/bind'))).toHaveLength(2);
  } finally { surface.dispose(); }
});

it('retains a conflict as a pending attempt and reports a refused cancellation honestly', async () => {
  const surface = mount();
  try {
    await click('Bind SIWC');
    surface.setCallbackStatus(409);
    await submitCallback();
    expect(screen.getByText(/Operation conflict/)).toBeTruthy();
    await click('Cancel');
    expect(screen.getByText(/CPA did not cancel/)).toBeTruthy();
    expect(screen.queryByText('Binding cancelled')).toBeNull();
    surface.allowCancel();
    await click('Cancel');
    expect(screen.getByText('Binding cancelled')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  } finally { surface.dispose(); }
});

it('requires explicit confirmation before replacing an existing SIWC partition', async () => {
  const surface = mount({ ...FILE, siwc_bound: true, use_siwc: true });
  try {
    await click('Rebind SIWC');
    expect(screen.getByText(/Replace this credential’s existing SIWC partition/)).toBeTruthy();
    expect(surface.requests).toHaveLength(0);
    const buttons = screen.getAllByRole('button', { name: 'Rebind SIWC' });
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    expect(surface.requests.filter((request) => request.path.endsWith('/bind'))).toHaveLength(1);
    expect(surface.requests[0].body.rebind).toBe(true);
  } finally { surface.dispose(); }
});

it('keeps status read failures pending but ends an expired session', async () => {
  vi.useFakeTimers();
  const surface = mount();
  try {
    await click('Bind SIWC');
    surface.setReadStatus(503);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(/Status read failed/)).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    surface.setReadStatus(410);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(/Binding session expired/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  } finally { surface.dispose(); }
});

it('does not let a stale status response overwrite a confirmed cancellation', async () => {
  vi.useFakeTimers();
  const surface = mount();
  try {
    await click('Bind SIWC');
    surface.holdRead();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    surface.allowCancel();
    await click('Cancel');
    await act(async () => { surface.releaseRead({ status: 'ok', file: { ...FILE, siwc_bound: true } }); });
    expect(screen.getByText('Binding cancelled')).toBeTruthy();
    expect(screen.queryByText('SIWC bound; credential summary confirmed')).toBeNull();
  } finally { surface.dispose(); }
});

it('shows CPA local status and verifies the use switch without binding or losing the material summary', async () => {
  const original = { ...FILE, siwc_status: 'invalid' as const, use_siwc: true, siwc_bound: true };
  const fixture = mount(original);
  const requests: Record<string, unknown>[] = [];
  let resolveWrite: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', async (input: string, options: RequestInit) => {
    expect(new URL(input, 'http://localhost').pathname).toMatch(/\/management\/auth-files\/fields$/);
    expect(options.method).toBe('PATCH');
    requests.push(JSON.parse(String(options.body)));
    return new Promise<Response>((resolve) => { resolveWrite = resolve; });
  });
  try {
    expect(screen.getByText('Locally invalid')).toBeTruthy();
    const control = screen.getByRole('switch', { name: 'Use bound SIWC' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(control); });
    expect(requests).toEqual([{ name: FILE.name, auth_index: FILE.auth_index, use_siwc: false }]);
    expect(control.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(control.hasAttribute('disabled')).toBe(true));
    await act(async () => { resolveWrite?.(new Response(JSON.stringify({ status: 'ok', file: { ...original, use_siwc: false, siwc_status: 'off' } }), { status: 200 })); });
    await screen.findByText('Off', { exact: true });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: 'Rebind SIWC' })).toBeTruthy();
    await act(async () => { fireEvent.click(control); });
    await act(async () => { resolveWrite?.(new Response(JSON.stringify({ error: 'field update could not be verified' }), { status: 502 })); });
    await screen.findByText('Could not confirm the SIWC use setting. Refresh the credential before trying again.');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(requests[1]).toEqual({ name: FILE.name, auth_index: FILE.auth_index, use_siwc: true });
  } finally { fixture.dispose(); }
});

it('refreshes credential state after an unverified write without reporting it as saved', async () => {
  let stored: ManagementAuthFile = { ...FILE, siwc_status: 'invalid', use_siwc: true, siwc_bound: true };
  let listReads = 0;
  const writes: Record<string, unknown>[] = [];
  let resolveWrite: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', async (input: string, options: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname;
    if (path.endsWith('/management/auth-files') && options.method === 'GET') {
      listReads++;
      return new Response(JSON.stringify({ files: [stored] }), { status: 200 });
    }
    if (path.endsWith('/management/auth-files/fields') && options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)));
      stored = { ...stored, use_siwc: false, siwc_status: 'off' };
      return new Promise<Response>((resolve) => { resolveWrite = resolve; });
    }
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const bindings = useSIWCBindings();
    const credentials = useQuery({ queryKey: ['management-auth-files'], queryFn: () => api.getManagementAuthFiles() });
    const file = credentials.data?.files[0];
    return file ? <SIWCBindingPanel file={file} canEdit bindings={bindings} /> : null;
  }
  const surface = render(<App><QueryClientProvider client={client}><I18nProvider><Harness /></I18nProvider></QueryClientProvider></App>);
  try {
    const control = await screen.findByRole('switch', { name: 'Use bound SIWC' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(control); });
    expect(writes).toEqual([{ name: FILE.name, auth_index: FILE.auth_index, use_siwc: false }]);
    expect(control.getAttribute('aria-checked')).toBe('true');
    await act(async () => { resolveWrite?.(new Response(JSON.stringify({ error: 'field update could not be verified' }), { status: 502 })); });
    await screen.findByText('Could not confirm the SIWC use setting. Refresh the credential before trying again.');
    await waitFor(() => expect(listReads).toBe(2));
    await screen.findByText('Off', { exact: true });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('Auth file fields saved')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rebind SIWC' })).toBeTruthy();
  } finally { surface.unmount(); client.clear(); }
});

it('keeps missing local status unknown even with bound material and a future stored expiry', () => {
  const fixture = mount({ ...FILE, siwc_bound: true, use_siwc: true, siwc_expires_at: '2099-01-01T00:00:00Z' });
  try {
    expect(screen.getByText('Unknown', { exact: true })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Use bound SIWC' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Locally valid', { exact: true })).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  } finally { fixture.dispose(); }
});

it('requires a bound partition before enabling SIWC', () => {
  const fixture = mount({ ...FILE, siwc_status: 'off', siwc_bound: false, use_siwc: false });
  try {
    const control = screen.getByRole('switch', { name: 'Use bound SIWC' });
    expect(control.hasAttribute('disabled')).toBe(true);
    fireEvent.click(control);
    expect(fixture.requests).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Bind SIWC' }).hasAttribute('disabled')).toBe(false);
  } finally { fixture.dispose(); }
});

it('lets the operator disable SIWC even when binding material is missing', () => {
  const fixture = mount({ ...FILE, siwc_status: 'invalid', siwc_bound: false, use_siwc: true });
  try {
    expect(screen.getByRole('switch', { name: 'Use bound SIWC' }).hasAttribute('disabled')).toBe(false);
  } finally { fixture.dispose(); }
});
