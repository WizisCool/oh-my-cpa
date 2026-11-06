import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SIWCBindingPanel } from '../src/components/authFiles/SIWCBindingPanel';
import { useSIWCBindings } from '../src/hooks/useSIWCBindings';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const FILE: ManagementAuthFile = { name: 'codex.json', auth_index: 'idx-1', provider: 'codex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, siwc_bind_supported: true, use_siwc: false, siwc_bound: false };
const OTHER: ManagementAuthFile = { ...FILE, name: 'other.json', auth_index: 'idx-2' };
const CALLBACK = 'http://127.0.0.1:1455/auth/callback?state=state-idx-1&code=SYNTHETIC-CODE&client_id=issued&extra=a%2Bb';

afterEach(() => { vi.useRealTimers(); });

function mount(file = FILE) {
  let status: object = { status: 'wait' };
  let callbackStatus = 200;
  let readStatus = 200;
  let isCancelled = false;
  const omc = installOmcApi();
  omc.on('POST', '/management/oauth/siwc/bind', request => ({
    url: 'https://auth.openai.com/api/accounts/authorize', state: `state-${(request.body as { auth_index: string }).auth_index}`, flow: 'siwc_bind', expires_in: 300,
  }));
  omc.on('GET', '/management/oauth/siwc/status', () => json(status, readStatus));
  omc.on('POST', '/management/oauth/siwc/callback', () => json({ status: 'ok' }, callbackStatus));
  omc.on('DELETE', '/management/oauth/siwc/session', () => ({ cancelled: isCancelled }));
  const requests = () => omc.requests.map(request => ({
    path: request.path, method: request.method, body: (request.body ?? {}) as Record<string, unknown>, state: request.query.get('state'),
  }));
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
  const surface = renderWithOmc(<Harness />);
  return {
    ...surface, omc,
    get requests() { return requests(); },
    setStatus: (value: object) => { status = value; },
    setCallbackStatus: (value: number) => { callbackStatus = value; },
    setReadStatus: (value: number) => { readStatus = value; },
    allowCancel: () => { isCancelled = true; },
    dispose: () => { surface.unmount(); },
  };
}
async function click(name: string | RegExp) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
async function submitCallback(callbackUrl = CALLBACK) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Complete callback URL' }), { target: { value: callbackUrl } });
  await click('Submit callback URL');
}

it('preserves the trimmed callback and waits for completed credential readback before success', async () => {
  vi.useFakeTimers();
  const surface = mount();
  try {
    await click('Bind SIWC');
    expect(surface.requests[0].body).toEqual({ name: FILE.name, auth_index: FILE.auth_index, rebind: false });
    surface.setStatus({ status: 'wait', completed: true });
    await submitCallback(` \t${CALLBACK}\r\n `);
    expect(surface.requests.find((request) => request.path.endsWith('/callback'))?.body).toEqual({ redirect_url: CALLBACK });
    expect(screen.getByText(/CPA completed binding/)).toBeTruthy();
    expect(screen.queryByText('SIWC bound; credential summary confirmed')).toBeNull();
    surface.setStatus({ status: 'ok', completed: true, file: { ...FILE, siwc_bound: true, use_siwc: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('SIWC bound; credential summary confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rebind SIWC' })).toBeTruthy();
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
  } finally { surface.dispose(); }
});

it('shows CPA local status and verifies the use switch without binding or losing the material summary', async () => {
  const original = { ...FILE, siwc_status: 'invalid' as const, use_siwc: true, siwc_bound: true };
  const fixture = mount(original);
  let resolveWrite: ((response: Response) => void) | undefined;
  fixture.omc.on('PATCH', '/management/auth-files/fields', () => new Promise<Response>(resolve => { resolveWrite = resolve; }));
  const requests = () => fixture.omc.writes('/management/auth-files/fields').map(request => request.body);
  try {
    expect(screen.getByText('Locally invalid')).toBeTruthy();
    const control = screen.getByRole('switch', { name: 'Use bound SIWC' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(control); });
    expect(requests()).toEqual([{ name: FILE.name, auth_index: FILE.auth_index, use_siwc: false }]);
    await waitFor(() => expect(control.hasAttribute('disabled')).toBe(true));
    await act(async () => { resolveWrite?.(new Response(JSON.stringify({ status: 'ok', file: { ...original, use_siwc: false, siwc_status: 'off' } }), { status: 200 })); });
    await screen.findByText('Off', { exact: true });
    expect(control.getAttribute('aria-checked')).toBe('false');
  } finally { fixture.dispose(); }
});
