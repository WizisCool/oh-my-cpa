import React from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupTask, defaultWarmupTaskInput, hasCustomTaskName } from '../src/types/warmup';

function mount(children: React.ReactNode) {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture());
  const surface = renderWithOmc(children, { isStrict: true });
  return { ...surface, omc, get requests() { return omc.requests; } };
}

it('validates task drafts and recognises server-made names', () => {
  const draft = defaultWarmupTaskInput({
    timezone: 'UTC',
    providers: [{
      provider: 'claude',
      accounts: [{
        auth_index: 'exact-claude',
        name: 'claude.json',
        provider: 'claude',
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
        auto_model: 'claude-haiku-4-5',
        windows: [{ id: 'five_hour', label: '5h', used_percent: null }],
      }],
    }],
  });
  expect(canSaveWarmupTask(draft)).toBe(true);
  expect(canSaveWarmupTask({ ...draft, provider: '' })).toBe(false);
  expect(canSaveWarmupTask({ ...draft, trigger: { kind: 'daily', time: '24:00', time_zone: 'UTC' } })).toBe(false);
  // A server-made name is frozen at save time, so it reads as unnamed and follows later edits.
  expect(hasCustomTaskName({ ...draft, name: 'claude.json (five_hour)' })).toBe(false);
  // Names saved before the parenthesised form still read as generated.
  expect(hasCustomTaskName({ ...draft, name: 'claude.json \u00b7 five_hour' })).toBe(false);
  expect(hasCustomTaskName({ ...draft, name: 'Morning' })).toBe(true);
});

it('runs a task manually and clears its history', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText('claude.json 窗口重置后 (5h)');

  fireEvent.click(await screen.findByRole('button', { name: 'Send once now' }));
  const history = await screen.findByTestId('warmup-last-result');
  expect(await within(history).findByText('Succeeded')).toBeTruthy();
  expect(surface.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/run'))).toHaveLength(1);

  fireEvent.click(screen.getByTestId('warmup-clear-runs'));
  // The trigger and the confirmation's verb share a name; the confirmation opens last.
  fireEvent.click((await screen.findAllByRole('button', { name: 'Clear history' })).at(-1)!);
  await screen.findByText('No runs recorded yet');
  const clears = surface.requests.filter((request) => request.method === 'DELETE' && request.path.includes('/warmup/runs'));
  expect(clears).toHaveLength(1);
  expect(clears[0].query.getAll('task_id')).toEqual([]);
  surface.unmount();
});

it('creates a new warmup task from the settings drawer', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText('claude.json 窗口重置后 (5h)');

  fireEvent.click(screen.getByTestId('warmup-add-task'));
  const dialog = await screen.findByTestId('warmup-task-editor');
  // A grouped window names its model group as well as its period, which does not fit one row
  // of options: laid out as a row, each label was truncated to its middle and two providers'
  // five-hour windows read alike.
  expect(within(dialog).getByRole('radiogroup', { name: 'Target window' }).getAttribute('aria-orientation')).toBe('vertical');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Morning Claude Warmup' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Morning Claude Warmup');

  const creates = surface.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/tasks'));
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({
    name: 'Morning Claude Warmup',
    enabled: true,
    provider: 'claude',
    auth_index: 'exact-claude',
    trigger: { kind: 'window', window: 'five_hour' },
  });
  surface.unmount();
});

it('keeps an open draft when a background refresh fails', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText('claude.json 窗口重置后 (5h)');

  fireEvent.click(screen.getByTestId('warmup-add-task'));
  const dialog = await screen.findByTestId('warmup-task-editor');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Unsaved draft' } });

  surface.omc.on('GET', /\/warmup\/settings$/, () => json({ code: 'warmup_unavailable', error: 'warmup_unavailable' }, 503));
  await act(() => surface.client.refetchQueries({ queryKey: ['quota-warmup-settings'] }));
  // The query tells its observers on the next task, so the failure reaches the drawer only then.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(surface.client.getQueryState(['quota-warmup-settings'])?.status).toBe('error');
  expect(within(screen.getByTestId('warmup-task-editor')).getByLabelText('Name')).toHaveProperty('value', 'Unsaved draft');
  surface.unmount();
});
