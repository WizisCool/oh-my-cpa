import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { QUOTA_GROUP_LABEL_SEPARATOR } from '../src/pages/quota/quotaWindowSelection';
import { WarmupSettingsDrawer } from '../src/components/authFiles/CredentialWarmup';
import { createWarmupFixture } from '../../scripts/acceptance/warmup-fixture.mjs';
import { canSaveWarmupTask, defaultWarmupTaskInput, hasCustomTaskName, WARMUP_TASK_ORDER_PREFERENCE } from '../src/types/warmup';

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
  // The default Auto model (`value: ""`) is rendered in the select trigger, not left blank.
  expect(within(dialog).getByRole('combobox', { name: 'Warmup model' }).textContent).toContain('Auto (claude-haiku-4-5)');
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

it('groups warmup tasks by provider, supports drag-handle reordering per group, and persists order in preferences', async () => {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture({
    initialTasks: [
      {
        id: 't_claude_first',
        name: 'Claude first',
        enabled: true,
        provider: 'claude',
        auth_index: 'exact-claude',
        account: 'claude-a.json',
        model: '',
        trigger: { kind: 'window', window: 'five_hour' },
        created_at: '2026-10-13T05:00:00Z',
        updated_at: '2026-10-13T05:00:00Z',
      },
      {
        id: 't_codex_only',
        name: 'Codex task',
        enabled: true,
        provider: 'codex',
        auth_index: 'exact-codex',
        account: 'codex.json',
        model: '',
        trigger: { kind: 'window', window: 'weekly' },
        created_at: '2026-10-13T05:01:00Z',
        updated_at: '2026-10-13T05:01:00Z',
      },
      {
        id: 't_claude_second',
        name: 'Claude second',
        enabled: true,
        provider: 'claude',
        auth_index: 'exact-claude-2',
        account: 'claude-b.json',
        model: '',
        trigger: { kind: 'window', window: 'seven_day' },
        created_at: '2026-10-13T05:02:00Z',
        updated_at: '2026-10-13T05:02:00Z',
      },
    ],
  }));
  const surface = renderWithOmc(<WarmupSettingsDrawer open onClose={vi.fn()} />, { isStrict: true });

  await screen.findByTestId('warmup-status');
  const claudeSection = screen.getByTestId('warmup-provider-claude');
  const codexSection = screen.getByTestId('warmup-provider-codex');
  const claudeRowIds = () => Array.from(claudeSection.querySelectorAll<HTMLElement>('[data-reorder-key]')).map((el) => el.dataset.reorderKey);
  expect(claudeRowIds()).toEqual(['t_claude_first', 't_claude_second']);
  // Single-task provider group does not render a drag handle.
  expect(codexSection.querySelectorAll('[data-reorder-handle]')).toHaveLength(0);

  const firstHandle = await within(claudeSection).findByRole('button', { name: /Claude first/ });
  fireEvent.keyDown(firstHandle, { key: 'ArrowDown' });

  expect(claudeRowIds()).toEqual(['t_claude_second', 't_claude_first']);
  await waitFor(() => {
    const prefWrites = omc.requests.filter((r) => r.method === 'PUT' && r.path === `/preferences/${WARMUP_TASK_ORDER_PREFERENCE}`);
    expect(prefWrites).toHaveLength(1);
    expect(prefWrites[0].body).toEqual({ claude: ['t_claude_second', 't_claude_first'] });
  });
  surface.unmount();
});

it('batch-creates warmup tasks across multiple credentials from the New task modal', async () => {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture({
    initialTasks: [],
    catalog: {
      timezone: 'UTC',
      providers: [
        {
          provider: 'claude',
          accounts: [{
            auth_index: 'exact-claude',
            name: 'claude.json',
            email: 'claude@team.test',
            provider: 'claude',
            models: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
            auto_model: 'claude-haiku-4-5',
            windows: [
              { id: 'five_hour', label: '5h', used_percent: 0 },
              { id: 'seven_day', label: '7d', used_percent: 0 },
            ],
          }],
        },
        {
          provider: 'codex',
          accounts: [
            {
              auth_index: 'exact-codex',
              name: 'codex.json',
              email: 'codex@team.test',
              provider: 'codex',
              models: ['gpt-5.4-mini'],
              auto_model: 'gpt-5.4-mini',
              windows: [
                { id: 'five_hour', label: '5h', used_percent: 0 },
                { id: 'weekly', label: '7d', used_percent: 0 },
              ],
            },
            {
              auth_index: 'disabled-codex',
              name: 'disabled.json',
              provider: 'codex',
              disabled: true,
              models: ['gpt-5.4-mini'],
              auto_model: 'gpt-5.4-mini',
              windows: [],
            },
          ],
        },
      ],
    },
  }));
  const surface = renderWithOmc(<WarmupSettingsDrawer open onClose={vi.fn()} />, { isStrict: true });
  try {
    fireEvent.click(await screen.findByTestId('warmup-add-task'));
    const dialog = await screen.findByTestId('warmup-task-editor');

    // Select all available credentials (excludes disabled credential).
    fireEvent.click(within(dialog).getByTestId('warmup-select-all-credentials'));
    expect(within(dialog).getByRole('combobox', { name: 'Warmup model' }).textContent).toContain('Auto (lightest model per credential)');

    // Choose the normalized 7-day window and provide a name prefix.
    fireEvent.click(within(dialog).getByRole('radio', { name: '7-day window' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Weekly' } });

    const submit = screen.getByRole('button', { name: 'Create 2 tasks' });
    fireEvent.click(submit);

    await screen.findByText('Weekly (claude@team.test)');
    await screen.findByText('Weekly (codex@team.test)');

    const batchCalls = omc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/tasks/batch'));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].body).toEqual({
      tasks: [
        {
          name: 'Weekly (claude@team.test)',
          enabled: true,
          provider: 'claude',
          auth_index: 'exact-claude',
          account: 'claude.json',
          model: '',
          trigger: { kind: 'window', window: 'seven_day' },
        },
        {
          name: 'Weekly (codex@team.test)',
          enabled: true,
          provider: 'codex',
          auth_index: 'exact-codex',
          account: 'codex.json',
          model: '',
          trigger: { kind: 'window', window: 'weekly' },
        },
      ],
    });
  } finally {
    surface.unmount();
  }
});

it('keeps grouped window names readable when selecting multiple credentials of a grouped-window provider', async () => {
  const omc = installOmcApi();
  omc.serve(/\/warmup(\/|$)/, createWarmupFixture({
    initialTasks: [],
    catalog: {
      timezone: 'UTC',
      providers: [
        {
          provider: 'antigravity',
          accounts: [
            {
              auth_index: 'ag-1',
              name: 'ag-1.json',
              provider: 'antigravity',
              models: ['gemini-3-flash'],
              auto_model: 'gemini-3-flash',
              windows: [
                { id: 'ag_gemini_5h', label: `Gemini Models${QUOTA_GROUP_LABEL_SEPARATOR}5h`, used_percent: 0 },
              ],
            },
            {
              auth_index: 'ag-2',
              name: 'ag-2.json',
              provider: 'antigravity',
              models: ['gemini-3-flash'],
              auto_model: 'gemini-3-flash',
              windows: [
                { id: 'ag_gemini_5h', label: `Gemini Models${QUOTA_GROUP_LABEL_SEPARATOR}5h`, used_percent: 10 },
              ],
            },
          ],
        },
      ],
    },
  }));
  const surface = renderWithOmc(<WarmupSettingsDrawer open onClose={vi.fn()} />, { isStrict: true });
  try {
    fireEvent.click(await screen.findByTestId('warmup-add-task'));
    const dialog = await screen.findByTestId('warmup-task-editor');
    fireEvent.click(within(dialog).getByTestId('warmup-select-all-credentials'));

    const windowGroup = within(dialog).getByRole('radiogroup', { name: 'Target window' });
    expect(windowGroup.textContent).toContain('Gemini Models');
    expect(windowGroup.textContent).not.toContain('ag_gemini_5h');
  } finally {
    surface.unmount();
  }
});
