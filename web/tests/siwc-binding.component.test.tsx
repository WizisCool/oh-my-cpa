import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
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
