import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { UpdateAction, UpdateStatusLine, UpdaterSetup, UPDATER_INSTALL_COMMAND } from '../src/pages/SystemPage/UpdateControls';
import { UPDATER_QUERY_KEY, useConsoleUpdate, type UpdateOutcome } from '../src/pages/SystemPage/useConsoleUpdate';
import { UPDATE_STATUS_REFRESH_MS, usePendingUpdates } from '../src/hooks/useUpdateNotice';
import { deriveUpdateOffer } from '../src/pages/SystemPage/versionPresentation';
import type { SystemProductVersion } from '../src/types/system';
import { createSystemUpdaterFixture, SYSTEM_UPDATER_CONTRACT } from '../../scripts/acceptance/system-updater-fixture.mjs';

const VERSION: SystemProductVersion = {
  product: 'omc', running_version: 'v1.0.0', latest_version: 'v1.1.0',
  state: 'update_available', reason: '', repository: 'owner/product', repository_url: 'https://github.com/owner/product',
  checked_at_ms: 1000, attempted_at_ms: 1000, check_error: '', checking: false,
  merge_count: 0, range_complete: true, notes_available: false,
};

function Card({ onFinished }: { onFinished: (outcome: UpdateOutcome) => void }) {
  const { updater, latest, submittingProduct, apply } = useConsoleUpdate({ onFinished });
  const offer = deriveUpdateOffer(VERSION, updater, 'omc');
  return (
    <>
      <output data-testid="updater-answers">{JSON.stringify({ progress: updater?.state ?? null, latest: latest?.state ?? null })}</output>
      <UpdateAction version={VERSION} productTitle="Oh My CPA" offer={offer} isSubmitting={submittingProduct === 'omc'} onUpdate={() => void apply('omc')} />
      <UpdateStatusLine offer={offer} />
      <UpdaterSetup updater={updater} />
    </>
  );
}

type Reply = () => Response | Promise<Response>;

function mount(fixture = createSystemUpdaterFixture()) {
  const overrides: Reply[] = [];
  const omc = installOmcApi();
  omc.serve(/^\/management\/system\/updater/, fixture);
  omc.on('*', /^\/management\/system\/updater/, request => {
    const override = request.method === 'GET' ? overrides.shift() : undefined;
    if (override) return override();
    return undefined;
  });
  const requests = () => omc.requests.map(request => ({ method: request.method, path: `/api/v1${request.path}` }));
  const onFinished = vi.fn<(outcome: UpdateOutcome) => void>();
  const surface = renderWithOmc(<Card onFinished={onFinished} />, { isStrict: true });
  const reread = () => act(async () => { await surface.client.refetchQueries({ queryKey: UPDATER_QUERY_KEY }); });
  const close = () => { surface.unmount(); };
  return { fixture, get requests() { return requests(); }, overrides, onFinished, reread, close };
}

async function startUpdate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Update Oh My CPA to v1.1.0' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
  await screen.findByText('Pulling the new image…');
}

it('asks before updating, tracks steps across restart, and reports the finished job once', async () => {
  const surface = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Update Oh My CPA to v1.1.0' }));
  await screen.findByText('Update Oh My CPA to v1.1.0?');
  expect(surface.requests.some((entry) => entry.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
  await screen.findByText('Pulling the new image…');
  expect(surface.requests.filter((entry) => entry.method === 'POST').map((entry) => entry.path)).toEqual(['/api/v1/management/system/updater/apply']);

  const reached = () => Array.from(screen.getByTestId('sys-update-steps').children).map((step) => step.getAttribute('data-reached'));
  expect(reached()).toEqual(['true', 'false', 'false', 'false']);

  surface.overrides.push(() => Promise.reject(new TypeError('Failed to fetch')));
  await surface.reread();
  surface.overrides.push(() => new Response(JSON.stringify(SYSTEM_UPDATER_CONTRACT.not_installed), { status: 200 }));
  await surface.reread();
  expect(screen.getByTestId('sys-update-stage')).toBeTruthy();

  surface.fixture.advance('verifying');
  await surface.reread();
  await screen.findByText('Checking that the new container is healthy…');
  expect(reached()).toEqual(['true', 'true', 'true', 'true']);

  surface.fixture.advance('done');
  await surface.reread();
  await waitFor(() => expect(surface.onFinished).toHaveBeenCalledTimes(1));
  expect(surface.onFinished.mock.calls[0][0].job).toMatchObject({ id: SYSTEM_UPDATER_CONTRACT.accepted.job.id, stage: 'done', finished: true });
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

it('offers the install command only to a deployment that can use it', async () => {
  const absent = mount(createSystemUpdaterFixture({ state: 'not_installed' }));
  const setup = await screen.findByTestId('sys-updater-setup');
  expect(setup.textContent).toContain(UPDATER_INSTALL_COMMAND);
  expect(screen.queryByTestId('sys-apply-update')).toBeNull();
  absent.close();
});

it('automatically refreshes plugin update observations on the shared notice interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const server = installOmcApi();
    let hasPluginUpdate = false;
    server.on('GET', '/management/system/updates', () => ({
      omc_version: { ...VERSION, state: 'up_to_date' },
      cpa_version: { ...VERSION, product: 'cpa', state: 'up_to_date' },
      plugin_update_available: hasPluginUpdate,
    }));
    function Reminders() {
      const { hasPluginUpdate: hasUpdate } = usePendingUpdates();
      return <output data-testid="plugin-update-notice">{String(hasUpdate)}</output>;
    }
    const surface = renderWithOmc(<Reminders />);
    await waitFor(() => expect(server.requests.filter(request => request.path === '/management/system/updates')).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('plugin-update-notice').textContent).toBe('false');
    hasPluginUpdate = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS); });
    await waitFor(() => expect(screen.getByTestId('plugin-update-notice').textContent).toBe('true'));
    hasPluginUpdate = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS); });
    await waitFor(() => expect(screen.getByTestId('plugin-update-notice').textContent).toBe('false'));
    expect(server.requests.every(request => request.method === 'GET')).toBe(true);
    surface.unmount();
  } finally {
    vi.useRealTimers();
  }
});
