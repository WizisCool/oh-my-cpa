import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreference, type PreferenceWrite } from '../src/hooks/usePreference';
import { installOmcApi, json as jsonResponse, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { TokenDisplayProvider, useTokenDisplayStyle } from '../src/types/tokenDisplayContext';
import { MotionPreferenceSync, MotionProvider, useReducedMotionPreference } from '../src/hooks/useReducedMotionPreference';
import { usePrefersReducedMotion } from '../src/hooks/usePrefersReducedMotion';
import { isMotionReduced, REDUCED_MOTION_QUERY } from '../src/utils/motionPreference';
import { ContextReadout } from '../src/components/workspace/ContextReadout';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

const parseString = (raw: unknown) => typeof raw === 'string' ? raw : undefined;
let writeResults: Promise<PreferenceWrite>[];
let api: OmcApi;
let isDraining: boolean;
let stored: Record<string, unknown>;
let writes: { key: string; value: unknown; options: RequestInit; response: ReturnType<typeof deferred<Response>> }[];

const reads = () => api.requests.filter(request => request.method === 'GET' && request.path === '/preferences').length;

function PreferenceControl({ name, preferenceKey = 'omc_tps_calculation_mode' }: { name: string; preferenceKey?: string }) {
  const preference = usePreference(preferenceKey, 'exclude_ttft', parseString);
  return <section aria-label={name}>
    <output aria-label={`${name} value`}>{preference.value}</output>
    <output aria-label={`${name} ready`}>{String(preference.ready)}</output>
    <output aria-label={`${name} loaded`}>{String(preference.loaded)}</output>
    <button onClick={() => { writeResults.push(preference.set('include_ttft')); }}>{name} include</button>
    <button onClick={() => { writeResults.push(preference.set('exclude_ttft')); }}>{name} exclude</button>
  </section>;
}

function DisplayControl() {
  const { setStyle } = useTokenDisplayStyle();
  return <>
    <button onClick={() => { setStyle('full'); }}>Full token reading</button>
    <ContextReadout usedTokens={10_000} windowTokens={100_000} />
  </>;
}

const mount = (children: React.ReactNode) => renderWithOmc(children, { isStrict: true });

async function completeWrite(index: number, status = 200, error = 'write_busy') {
  const write = writes[index];
  await act(async () => {
    if (status === 200) stored[write.key] = write.value;
    write.response.resolve(jsonResponse(status === 200 ? { key: write.key, value: write.value } : { error }, status));
    await writeResults[index];
  });
}

beforeEach(() => {
  writeResults = [];
  isDraining = false;
  writes = [];
  api = installOmcApi();
  // The store itself is what each test seeds and reads back; a write lands in it only
  // when the test completes that write, so an in-flight write is observable.
  stored = api.state.preferences;
  api.on('PUT', /^\/preferences\//, request => {
    const response = deferred<Response>();
    writes.push({ key: request.path.split('/').pop()!, value: request.body, options: request.init, response });
    if (isDraining) response.resolve(jsonResponse({ key: writes.at(-1)!.key, value: writes.at(-1)!.value }));
    return response.promise;
  });
});

afterEach(async () => {
  // Drain admitted and subsequently queued writes even when an assertion fails;
  // the production per-key queue must not become the next test's fixture.
  await act(async () => {
    isDraining = true;
    for (const write of writes) write.response.resolve(jsonResponse({ key: write.key, value: write.value }));
    await Promise.all(writeResults);
  });
});

describe('real preference hook and cache integration', () => {
  it('waits for a held read, shares one StrictMode query and publishes optimistic updates to both readers', async () => {
    const read = api.hold('GET', '/preferences');
    mount(<><PreferenceControl name="first" /><PreferenceControl name="second" /></>);
    expect(screen.getByLabelText('first ready').textContent).toBe('false');
    expect(screen.getByLabelText('first loaded').textContent).toBe('false');
    expect(screen.getByLabelText('first value').textContent).toBe('exclude_ttft');
    await act(async () => { read.release(jsonResponse({ preferences: { omc_tps_calculation_mode: 'include_ttft' } })); });
    await waitFor(() => expect(screen.getByLabelText('second value').textContent).toBe('include_ttft'));
    expect(reads()).toBe(1);
    expect(screen.getByLabelText('first ready').textContent).toBe('true');
    expect(screen.getByLabelText('first loaded').textContent).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'first exclude' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('second value').textContent).toBe('exclude_ttft'));
    expect(stored.omc_tps_calculation_mode).toBeUndefined();
    expect(writes[0].options.keepalive).toBe(true);
    await completeWrite(0);
    expect(await writeResults[0]).toEqual({ ok: true });
    expect(reads()).toBe(1);
  });

  it('rolls back a refused optimistic write, presents the real feedback and permits a subsequent save', async () => {
    stored.omc_tps_calculation_mode = 'include_ttft';
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('exclude_ttft'));
    await completeWrite(0, 503);
    expect(await writeResults[0]).toEqual({ ok: false });
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    await screen.findByText('write_busy');
    expect(stored.omc_tps_calculation_mode).toBe('include_ttft');
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    await completeWrite(1);
    expect(await writeResults[1]).toEqual({ ok: true });
    expect(stored.omc_tps_calculation_mode).toBe('exclude_ttft');
    expect(reads()).toBe(1);
  });

  it('serializes a key and never lets an older failure erase a newer optimistic intent', async () => {
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'setting exclude' }));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await act(async () => { await Promise.resolve(); });
    expect(writes).toHaveLength(1);
    await completeWrite(0, 503);
    await waitFor(() => expect(writes).toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText('setting value').textContent).toBe('include_ttft'));
    await completeWrite(1);
    await waitFor(() => expect(writes).toHaveLength(3));
    await completeWrite(2);
    expect(await Promise.all(writeResults)).toEqual([{ ok: false }, { ok: true }, { ok: true }]);
    expect(stored.omc_tps_calculation_mode).toBe('include_ttft');
  });

  it('does not serialize unrelated keys behind a held write', async () => {
    mount(<><PreferenceControl name="tps" /><PreferenceControl name="tokens" preferenceKey="omc_token_style" /></>);
    await waitFor(() => expect(screen.getByLabelText('tps ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'tps include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'tokens include' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(write => write.key)).toEqual(['omc_tps_calculation_mode', 'omc_token_style']);
    await completeWrite(1);
    expect(stored.omc_token_style).toBe('include_ttft');
    expect(stored.omc_tps_calculation_mode).toBeUndefined();
    await completeWrite(0);
  });

  it('completes an already admitted keepalive write after unmount and reads it on a fresh mount', async () => {
    const view = mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'setting include' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    view.unmount();
    await completeWrite(0);
    mount(<PreferenceControl name="reopened" />);
    await waitFor(() => expect(screen.getByLabelText('reopened value').textContent).toBe('include_ttft'));
    expect(reads()).toBe(2);
  });

  it('exposes a usable fallback after a failed initial read rather than remaining unready', async () => {
    api.on('GET', '/preferences', () => jsonResponse({ error: 'database is unavailable' }, 503));
    mount(<PreferenceControl name="setting" />);
    await waitFor(() => expect(screen.getByLabelText('setting ready').textContent).toBe('true'));
    expect(screen.getByLabelText('setting value').textContent).toBe('exclude_ttft');
    // Usable is not the same as known: a write derived from the stored document must wait.
    expect(screen.getByLabelText('setting loaded').textContent).toBe('false');
    expect(reads()).toBe(1);
  });

  it('isolates each preference while publishing its own updates with stable parsed values', async () => {
    stored.usage_events_columns = { provider: 200 };
    const parse = vi.fn((raw: unknown) => typeof raw === 'object' && raw !== null ? { ...(raw as object) } : undefined);
    const fallback = {};
    const values: object[] = [];
    function Columns() {
      const preference = usePreference('usage_events_columns', fallback, parse);
      values.push(preference.value);
      return <output aria-label="columns ready">{String(preference.ready)}</output>;
    }
    const { client } = mount(<><Columns /><PreferenceControl name="theme" preferenceKey="omc_theme" /></>);
    await waitFor(() => expect(screen.getByLabelText('columns ready').textContent).toBe('true'));
    const value = values.at(-1);
    const renderCount = values.length;
    await act(async () => { client.setQueryData(['preferences'], { ...stored, omc_theme: 'dark' }); });
    await waitFor(() => expect(screen.getByLabelText('theme value').textContent).toBe('dark'));
    expect(values).toHaveLength(renderCount);
    expect(values.at(-1)).toBe(value);
    await act(async () => { client.setQueryData(['preferences'], { ...stored, usage_events_columns: { provider: 240 } }); });
    await waitFor(() => expect(values.at(-1)).toEqual({ provider: 240 }));
    expect(values.at(-1)).not.toBe(value);
  });
});

describe('shared provider and real rendered consumer', () => {
  it('updates the context meter accessible reading through the real provider, hook and API client', async () => {
    stored.omc_token_style = 'short';
    mount(<TokenDisplayProvider><DisplayControl /></TokenDisplayProvider>);
    const meter = await screen.findByRole('meter');
    await waitFor(() => expect(meter.getAttribute('aria-valuetext')).toContain('10K'));
    fireEvent.click(screen.getByRole('button', { name: 'Full token reading' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].key).toBe('omc_token_style');
    expect(writes[0].value).toBe('full');
    await waitFor(() => expect(meter.getAttribute('aria-valuetext')).toContain('10,000'));
    await act(async () => { stored.omc_token_style = 'full'; writes[0].response.resolve(jsonResponse({ key: 'omc_token_style', value: 'full' })); });
    expect(reads()).toBe(1);
  });
});


describe('console motion preference', () => {
  it('resolves live system changes, explicit overrides, persistence and failed-write rollback for every consumer', async () => {
    let hasSystemReducedMotion = false;
    const listeners = new Set<() => void>();
    const query = {
      get matches() { return hasSystemReducedMotion; },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    const originalMatchMedia = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation(value => value === REDUCED_MOTION_QUERY
      ? query as unknown as MediaQueryList : originalMatchMedia(value));
    function Control() {
      const preference = useReducedMotionPreference();
      const isReduced = usePrefersReducedMotion();
      return <>
        <output aria-label="motion">{String(isReduced)}</output>
        <output aria-label="motion preference">{preference.value}</output>
        {(['on', 'system', 'off'] as const).map(value =>
          <button key={value} onClick={() => { writeResults.push(preference.set(value)); }}>{value}</button>)}
      </>;
    }
    const { unmount } = mount(<MotionProvider><MotionPreferenceSync /><Control /></MotionProvider>);
    await waitFor(() => expect(reads()).toBe(1));
    const expectReduced = (isReduced: boolean) => {
      expect(screen.getByLabelText('motion').textContent).toBe(String(isReduced));
      expect(document.documentElement.dataset.reducedMotion).toBe(String(isReduced));
      expect(isMotionReduced()).toBe(isReduced);
    };
    expectReduced(false);
    expect(screen.getByLabelText('motion preference').textContent).toBe('system');
    const changeSystem = async (isReduced: boolean) => {
      await act(async () => { hasSystemReducedMotion = isReduced; for (const listener of listeners) listener(); });
    };
    await changeSystem(true);
    expectReduced(true);
    fireEvent.click(screen.getByRole('button', { name: 'off' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expectReduced(false);
    expect(writes[0]).toMatchObject({ key: 'omc_reduced_motion', value: 'off' });
    await completeWrite(0, 500);
    await waitFor(() => expectReduced(true));
    await changeSystem(false);
    fireEvent.click(screen.getByRole('button', { name: 'on' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expectReduced(true);
    await completeWrite(1);
    expect(stored.omc_reduced_motion).toBe('on');
    await changeSystem(true);
    await changeSystem(false);
    expectReduced(true);
    fireEvent.click(screen.getByRole('button', { name: 'off' }));
    await waitFor(() => expect(writes).toHaveLength(3));
    await completeWrite(2);
    await changeSystem(true);
    expectReduced(false);
    unmount();
    expect(listeners.size).toBe(0);
    mount(<MotionProvider><MotionPreferenceSync /><Control /></MotionProvider>);
    await waitFor(() => expect(screen.getByLabelText('motion preference').textContent).toBe('off'));
    expectReduced(false);
  });
});
