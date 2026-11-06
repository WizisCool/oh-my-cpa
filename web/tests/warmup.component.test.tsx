import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { CredentialWarmup, WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupPolicy, DEFAULT_WARMUP_POLICY, type WarmupCredential } from '../src/types/warmup';

function mount(children: React.ReactNode, { isSettingsFailing = false } = {}) {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture());
  if (isSettingsFailing) omc.on('*', /\/warmup\/settings$/, () => json({ code: 'warmup_unavailable', error: 'warmup_unavailable' }, 500));
  const surface = renderWithOmc(children, { isStrict: true });
  return { ...surface, get requests() { return omc.requests; } };
}

it('uses safe defaults and requires a model before automatic activation', () => {
  expect(DEFAULT_WARMUP_POLICY.daily_time).toBe('06:00');
  expect(canSaveWarmupPolicy(DEFAULT_WARMUP_POLICY)).toBe(true);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_enabled: true })).toBe(false);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_enabled: true, model: 'haiku' })).toBe(true);
  expect(canSaveWarmupPolicy({ ...DEFAULT_WARMUP_POLICY, daily_time: '24:00' })).toBe(false);
});

it('reads an inherited policy, tracks draft ownership, and confirms a manual run', async () => {
  const onDirtyChange = vi.fn();
  const surface = mount(<CredentialWarmup authIndex="exact-claude" onDirtyChange={onDirtyChange} />);
  await screen.findByText('As soon as either window resets');
  expect(screen.getByText('Follows the Claude default in Warmup settings.')).toBeTruthy();

  const status = await screen.findByTestId('warmup-status');
  expect(within(status).getByText('Automatic warmup is paused')).toBeTruthy();

  fireEvent.click(screen.getByText('Custom'));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

  const runButton = await screen.findByRole('button', { name: 'Warm up now' });
  fireEvent.click(runButton);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Warm up now' }));
  const last = await screen.findByTestId('warmup-last-result');
  expect(within(last).getByText('Quota window started')).toBeTruthy();
  const runs = surface.requests.filter(request => request.method === 'POST');
  expect(runs).toHaveLength(1);
  expect(runs[0].body).toEqual({ confirmed: true, request_id: expect.any(String), revision: 'wire-revision' });

  const key = ['quota-warmup-credential', 'exact-claude'];
  act(() => surface.client.setQueryData<WarmupCredential>(key, previous => previous && previous.state.last_result ? { ...previous, state: { ...previous.state, last_result: { ...previous.state.last_result, request_id: 'later-automatic-run', trigger: 'reset', status: 'failed', reason: 'rate_limited' } } } : previous));
  await within(last).findByText('Warmup failed');
  surface.unmount();
});

it('keeps provider changes disabled while its default draft is unsaved', async () => {
  const surface = mount(<WarmupSettingsDrawer open onClose={vi.fn()} />);
  await screen.findByText("With a daily time set, the five-hour window starts at that time when possible. If it can't be sent within an hour of that time, that day's daily warmup is skipped.");
  fireEvent.click(screen.getByRole('switch', { name: 'Warm up daily at a set time' }));
  expect(screen.getByText('The five-hour window runs 06:00–11:00 (UTC)')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-disabled')).toBe('true');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  surface.unmount();
});
