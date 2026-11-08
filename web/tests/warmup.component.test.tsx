import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { CredentialWarmup, WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupTask, defaultWarmupTaskInput, pickAutoModel, sortModelsForAuto } from '../src/types/warmup';

function mount(children: React.ReactNode, { isSettingsFailing = false } = {}) {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture());
  if (isSettingsFailing) omc.on('*', /\/warmup\/settings$/, () => json({ code: 'warmup_unavailable', error: 'warmup_unavailable' }, 500));
  const surface = renderWithOmc(children, { isStrict: true });
  return { ...surface, get requests() { return omc.requests; } };
}

it('validates task drafts and selects the lightest auto model', () => {
  const draft = defaultWarmupTaskInput({
    auth_index: 'exact-claude',
    name: 'claude.json',
    provider: 'claude',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    auto_model: 'claude-haiku-4-5',
    windows: [{ id: 'five_hour', label: '5h', used_percent: null }],
  });
  expect(canSaveWarmupTask(draft)).toBe(true);
  expect(canSaveWarmupTask({ ...draft, provider: '' })).toBe(false);
  expect(canSaveWarmupTask({ ...draft, trigger: { kind: 'daily', time: '24:00', time_zone: 'UTC' } })).toBe(false);
  expect(sortModelsForAuto(['claude-sonnet-4-6', 'claude-haiku-4-5'])[0]).toBe('claude-haiku-4-5');
  expect(pickAutoModel(['gpt-5.4', 'gpt-5.4-mini'])).toBe('gpt-5.4-mini');
});

it('displays credential warmup tasks, tracks editor draft state, and runs a task manually', async () => {
  const onDirtyChange = vi.fn();
  const surface = mount(<CredentialWarmup authIndex="exact-claude" onDirtyChange={onDirtyChange} />);
  await screen.findByText('claude.json · 窗口重置后 (5h)');

  const status = await screen.findByTestId('warmup-status');
  expect(within(status).getByText('1 of 1 tasks enabled')).toBeTruthy();

  fireEvent.click(screen.getByTestId('warmup-add-task'));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

  const runButton = await screen.findByRole('button', { name: 'Send once now' });
  fireEvent.click(runButton);

  const last = await screen.findByTestId('warmup-last-result');
  expect(await within(last).findByText('Succeeded')).toBeTruthy();

  const runs = surface.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/run'));
  expect(runs).toHaveLength(1);
  surface.unmount();
});

it('creates a new warmup task from the settings drawer', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText('claude.json · 窗口重置后 (5h)');

  fireEvent.click(screen.getByTestId('warmup-add-task'));
  const nameInput = await screen.findByLabelText('Task name');
  fireEvent.change(nameInput, { target: { value: 'Morning Claude Warmup' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Morning Claude Warmup');

  const creates = surface.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/tasks'));
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({
    name: 'Morning Claude Warmup',
    enabled: true,
    provider: 'claude',
    auth_index: 'exact-claude',
  });
  surface.unmount();
});
