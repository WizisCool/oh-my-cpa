import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { UpdateAction, UpdateStatusLine, UpdaterSetup, UPDATER_INSTALL_COMMAND } from '../src/pages/SystemPage/UpdateControls';
import { UPDATE_WATCH_LIMIT_MS, UPDATER_QUERY_KEY, useConsoleUpdate, type UpdateOutcome } from '../src/pages/SystemPage/useConsoleUpdate';
import { deriveUpdateOffer } from '../src/pages/SystemPage/versionPresentation';
import type { SystemProductVersion } from '../src/types/system';
import { createSystemUpdaterFixture, SYSTEM_UPDATER_CONTRACT } from '../../scripts/acceptance/system-updater-fixture.mjs';

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const VERSION: SystemProductVersion = {
  product: 'omc', running_version: 'v1.0.0', latest_version: 'v1.1.0',
  state: 'update_available', reason: '', repository: 'owner/product', repository_url: 'https://github.com/owner/product',
  checked_at_ms: 1000, attempted_at_ms: 1000, check_error: '', checking: false,
  merge_count: 0, range_complete: true, notes_available: false,
};

/** The version card's update pieces over the real hook, as the page composes them. */
function Card({ onFinished }: { onFinished: (outcome: UpdateOutcome) => void }) {
  const { updater, submittingProduct, apply } = useConsoleUpdate({ onFinished });
  const offer = deriveUpdateOffer(VERSION, updater, 'omc');
  return (
    <>
      <UpdateAction version={VERSION} productTitle="Oh My CPA" offer={offer} isSubmitting={submittingProduct === 'omc'} onUpdate={() => void apply('omc')} />
      <UpdateStatusLine offer={offer} />
      <UpdaterSetup updater={updater} />
    </>
  );
}

type Reply = () => Response | Promise<Response>;

function mount(fixture = createSystemUpdaterFixture()) {
  const requests: { method: string; path: string }[] = [];
  // A queued reply stands in for one answer, which is how a test makes the console unreachable.
  const overrides: Reply[] = [];
  const reach = { isLost: false };
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    const method = options.method ?? 'GET';
    requests.push({ method, path });
    const override = method === 'GET' ? overrides.shift() : undefined;
    if (override) return override();
    if (reach.isLost) throw new TypeError('Failed to fetch');
    const result = fixture(new URL(path, 'http://127.0.0.1'), method, options.body as string);
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onFinished = vi.fn<(outcome: UpdateOutcome) => void>();
  const surface = render(
    <React.StrictMode><App><QueryClientProvider client={client}><I18nProvider><Card onFinished={onFinished} /></I18nProvider></QueryClientProvider></App></React.StrictMode>,
  );
  const reread = () => act(async () => { await client.refetchQueries({ queryKey: UPDATER_QUERY_KEY }); });
  const close = () => { surface.unmount(); client.clear(); };
  return { fixture, requests, overrides, reach, client, onFinished, reread, close };
}

async function startUpdate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Update Oh My CPA to v1.1.0' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
  await screen.findByText('Pulling the new image…');
}

it('asks before updating and sends nothing until the question is answered', async () => {
  const surface = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Update Oh My CPA to v1.1.0' }));
  await screen.findByText('Update Oh My CPA to v1.1.0?');
  expect(surface.requests.some((entry) => entry.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
  await screen.findByText('Pulling the new image…');
  expect(surface.requests.filter((entry) => entry.method === 'POST').map((entry) => entry.path)).toEqual(['/omc/api/v1/management/system/updater/apply']);
  surface.close();
});

it('draws a running update as the four steps the updater reports', async () => {
  const surface = mount();
  await startUpdate();
  const reached = () => Array.from(screen.getByTestId('sys-update-steps').children).map((step) => step.getAttribute('data-reached'));
  expect(reached()).toEqual(['true', 'false', 'false', 'false']);

  surface.fixture.advance('verifying');
  await surface.reread();
  await screen.findByText('Checking that the new container is healthy…');
  expect(reached()).toEqual(['true', 'true', 'true', 'true']);
  surface.close();
});

it('keeps showing the update while the console restarts under it, then reports the result once', async () => {
  const surface = mount();
  await startUpdate();

  // The console's own container is replaced: reads fail, and the first answers after it comes
  // back are from a console the updater has not been linked to yet.
  surface.overrides.push(() => Promise.reject(new TypeError('Failed to fetch')));
  await surface.reread();
  surface.overrides.push(() => new Response(JSON.stringify(SYSTEM_UPDATER_CONTRACT.not_installed), { status: 200 }));
  await surface.reread();
  expect(screen.getByTestId('sys-update-stage')).toBeTruthy();
  expect(screen.queryByTestId('sys-updater-setup')).toBeNull();
  expect(surface.onFinished).not.toHaveBeenCalled();

  surface.fixture.advance('verifying');
  await surface.reread();
  await screen.findByText('Checking that the new container is healthy…');

  surface.fixture.advance('done');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));
  expect(surface.onFinished.mock.calls[0][0].job).toMatchObject({ id: SYSTEM_UPDATER_CONTRACT.accepted.job.id, stage: 'done', finished: true });
  expect(screen.queryByTestId('sys-update-stage')).toBeNull();
  await surface.reread();
  expect(surface.onFinished).toHaveBeenCalledTimes(1);
  surface.close();
});

it('reports a rollback with the reason the updater gave', async () => {
  const surface = mount();
  await startUpdate();
  surface.fixture.advance('rolled_back', 'the replacement exited after starting');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));
  expect(surface.onFinished.mock.calls[0][0].job).toMatchObject({ stage: 'rolled_back', error: 'the replacement exited after starting' });
  surface.close();
});

it('gives up on an update whose updater forgot it or stopped answering', async () => {
  const forgotten = mount();
  await startUpdate();
  forgotten.overrides.push(() => new Response(JSON.stringify(SYSTEM_UPDATER_CONTRACT.ready), { status: 200 }));
  await forgotten.reread();
  await waitFor(() => expect(forgotten.onFinished).toHaveBeenCalledWith({ job: null, product: 'omc' }));
  forgotten.close();

  const silent = mount();
  await startUpdate();
  silent.reach.isLost = true;
  await silent.reread();
  expect(silent.onFinished).not.toHaveBeenCalled();
  expect(screen.getByTestId('sys-update-stage')).toBeTruthy();
  // The clock keeps running, only later: a frozen one would stall the schedulers under the page.
  const readClock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => readClock() + UPDATE_WATCH_LIMIT_MS);
  await silent.reread();
  await waitFor(() => expect(silent.onFinished).toHaveBeenCalledWith({ job: null, product: 'omc' }));
  await waitFor(() => expect(screen.queryByTestId('sys-update-stage')).toBeNull());
  expect(silent.onFinished).toHaveBeenCalledTimes(1);
  silent.close();
});

it('reports one end for the job it gave up on, even when the updater answers again', async () => {
  const surface = mount();
  await startUpdate();

  // The updater stops answering, and the console gives up on the running job once.
  surface.reach.isLost = true;
  await surface.reread();
  const readClock = Date.now.bind(Date);
  let clockShift = UPDATE_WATCH_LIMIT_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => readClock() + clockShift);
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));

  // The updater comes back and still names the job it lost. That answer is the update the page
  // has already ended: following it again would report a second end for one update, so the
  // console keeps the one report it made and waits for a different job.
  surface.reach.isLost = false;
  await surface.reread();
  surface.reach.isLost = true;
  await surface.reread();
  clockShift = 3 * UPDATE_WATCH_LIMIT_MS;
  await surface.reread();
  expect(surface.onFinished).toHaveBeenCalledTimes(1);
  expect(surface.onFinished).toHaveBeenCalledWith({ job: null, product: 'omc' });
  surface.close();
});

it('reports a later update that arrives with its own job id', async () => {
  const surface = mount();
  await startUpdate();
  surface.fixture.advance('done');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));

  // A later update, admitted under an id of its own, is followed and reported too: the end already
  // reported for the previous job must not swallow it. The stage line is what proves the page is
  // following this job before it finishes; reading twice without it can collapse into one render.
  surface.fixture.admit('job-later');
  await surface.reread();
  await screen.findByText('Pulling the new image…');
  surface.fixture.advance('done');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(2));
  expect(surface.onFinished.mock.calls[1][0].job).toMatchObject({ id: 'job-later', stage: 'done', finished: true });
  surface.close();
});

it('follows an update that was already running when the page opened', async () => {
  const fixture = createSystemUpdaterFixture();
  fixture(new URL('http://127.0.0.1/api/v1/management/system/updater/apply'), 'POST', JSON.stringify(SYSTEM_UPDATER_CONTRACT.accepted.body));
  const surface = mount(fixture);
  await screen.findByText('Pulling the new image…');
  fixture.advance('done');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));
  surface.close();
});

it('offers the install command only to a deployment that can use it', async () => {
  const absent = mount(createSystemUpdaterFixture({ state: 'not_installed' }));
  const setup = await screen.findByTestId('sys-updater-setup');
  expect(setup.textContent).toContain(UPDATER_INSTALL_COMMAND);
  expect(screen.queryByTestId('sys-apply-update')).toBeNull();
  absent.close();

  const native = mount(createSystemUpdaterFixture({ state: 'not_containerised' }));
  await waitFor(() => expect(native.requests.length).toBeGreaterThan(0));
  await native.reread();
  expect(screen.queryByTestId('sys-updater-setup')).toBeNull();
  expect(screen.queryByTestId('sys-apply-update')).toBeNull();
  native.close();

  const rejected = mount(createSystemUpdaterFixture({ state: 'rejected' }));
  await screen.findByTestId('sys-updater-rejected');
  expect(screen.queryByTestId('sys-updater-setup')).toBeNull();
  rejected.close();
});
