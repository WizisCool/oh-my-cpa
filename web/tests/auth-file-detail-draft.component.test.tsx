import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import { OAuthModelRulesDrawer } from '../src/components/authFiles/OAuthModelRulesDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi, json, type OmcApi } from './support/omcApi';

// The configuration section lists the provider's model catalogue for its excluded-models picker.
function serveProviderCatalog(api: OmcApi) {
  api.on('GET', '/management/auth-files/provider-models', (request) => ({
    provider: request.query.get('provider') ?? '', available: true, models: [],
  }));
}
import { renderWithOmc } from './support/render';

const FILE: ManagementAuthFile = { recovery_supported: true, name: 'claude.json', auth_index: 'exact-claude', type: 'claude', provider: 'claude', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, note: 'Original note' };
const FIELDS = { proxy_url: 'socks5h://%5Bredacted%5D@proxy.example.test:1080', name: FILE.name, note: FILE.note, disable_cooling: false, websockets: false, using_api: false, excluded_models: [], model_aliases: [] };

it('saves credential field changes without sending redacted proxy URLs', async () => {
  const api = installOmcApi({ authFiles: [{ file: FILE, fields: FIELDS }] });
  serveProviderCatalog(api);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = renderWithOmc(<AuthFileDetailDrawer file={FILE} open canEdit initialSection="configuration" onClose={onClose} onSaved={onSaved} onDownload={vi.fn()} />, { isStrict: true });
  try {
    const note = await screen.findByLabelText('Note');
    await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(note, { target: { value: 'Updated note' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    const writes = () => api.writes('/management/auth-files/fields').map(request => request.body);
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(writes()[0]).not.toHaveProperty('proxy_url');
  } finally {
    view.unmount();
  }
});

it('preserves credential status when only its display name is saved', async () => {
  const file = { ...FILE, status: 'error' };
  const api = installOmcApi({ authFiles: [{ file, fields: FIELDS }] });
  serveProviderCatalog(api);
  api.on('PUT', '/management/auth-files/display-name', () => ({ status: 'ok', display_name: 'Team seat', display_name_version: 1 }));
  const onSaved = vi.fn();
  const view = renderWithOmc(<AuthFileDetailDrawer file={file} open canEdit initialSection="configuration" onClose={vi.fn()} onSaved={onSaved} onDownload={vi.fn()} />);
  try {
    await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team seat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Fields' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onSaved.mock.calls[0][0]).toEqual({ ...file, display_name: 'Team seat', display_name_version: 1 });
    expect(api.writes('/management/auth-files/fields')).toHaveLength(0);
  } finally {
    view.unmount();
  }
});

it('reorders excluded models via the row handle and saves the new order', async () => {
  const fields = { ...FIELDS, excluded_models: ['claude-3-5-sonnet-20240620', 'claude-opus-*'] };
  const api = installOmcApi({ authFiles: [{ file: FILE, fields }] });
  api.on('GET', '/management/auth-files/provider-models', (request) => ({
    provider: request.query.get('provider') ?? '',
    available: true,
    models: [{ id: 'claude-3-5-sonnet-20240620', display_name: 'Claude 3.5 Sonnet' }],
  }));
  const onSaved = vi.fn();
  const view = renderWithOmc(
    <AuthFileDetailDrawer file={FILE} open canEdit initialSection="configuration" onClose={vi.fn()} onSaved={onSaved} onDownload={vi.fn()} />,
  );
  try {
    const list = await screen.findByTestId('oauth-excluded-models-typed-rules');
    await waitFor(() => expect(list.querySelectorAll('li[data-rule]')).toHaveLength(2));
    const handles = list.querySelectorAll<HTMLButtonElement>('[data-reorder-handle]');
    expect(handles).toHaveLength(2);
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      const order = Array.from(list.querySelectorAll('li[data-rule]')).map(el => el.getAttribute('data-rule'));
      expect(order).toEqual(['claude-opus-*', 'claude-3-5-sonnet-20240620']);
    });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    const writes = () => api.writes('/management/auth-files/fields').map(request => request.body);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ excluded_models: ['claude-opus-*', 'claude-3-5-sonnet-20240620'] });
  } finally {
    view.unmount();
  }
});

it('reorders credential model aliases via the row handle and saves the new order', async () => {
  const fields = {
    ...FIELDS,
    model_aliases: [
      { name: 'claude-3-5-sonnet-20240620', alias: 'sonnet', fork: true },
      { name: 'claude-opus-4-1', alias: 'opus', fork: true },
    ],
  };
  const api = installOmcApi({ authFiles: [{ file: FILE, fields }] });
  serveProviderCatalog(api);
  const view = renderWithOmc(
    <AuthFileDetailDrawer file={FILE} open canEdit initialSection="configuration" onClose={vi.fn()} onSaved={vi.fn()} onDownload={vi.fn()} />,
  );
  try {
    const list = await screen.findByTestId('credential-model-aliases-list');
    await waitFor(() => expect(list.querySelectorAll('li[data-alias-row]')).toHaveLength(2));
    const handles = list.querySelectorAll<HTMLButtonElement>('[data-reorder-handle]');
    expect(handles).toHaveLength(2);
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    await waitFor(() => {
      const inputs = Array.from(list.querySelectorAll<HTMLInputElement>('input[placeholder="Client alias"]')).map(el => el.value);
      expect(inputs).toEqual(['opus', 'sonnet']);
    });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    const writes = () => api.writes('/management/auth-files/fields').map(request => request.body);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      model_aliases: [
        { name: 'claude-opus-4-1', alias: 'opus', fork: true },
        { name: 'claude-3-5-sonnet-20240620', alias: 'sonnet', fork: true },
      ],
    });
  } finally {
    view.unmount();
  }
});

it('disables credential model alias reordering when read-only or while saving', async () => {
  const fields = {
    ...FIELDS,
    model_aliases: [
      { name: 'claude-3-5-sonnet-20240620', alias: 'sonnet', fork: true },
      { name: 'claude-opus-4-1', alias: 'opus', fork: true },
    ],
  };
  const api = installOmcApi({ authFiles: [{ file: FILE, fields }] });
  serveProviderCatalog(api);

  // 1. Read-only (canEdit = false)
  const readOnlyView = renderWithOmc(
    <AuthFileDetailDrawer file={FILE} open canEdit={false} initialSection="configuration" onClose={vi.fn()} onSaved={vi.fn()} onDownload={vi.fn()} />,
  );
  try {
    const list = await screen.findByTestId('credential-model-aliases-list');
    await waitFor(() => expect(list.querySelectorAll('li[data-alias-row]')).toHaveLength(2));
    expect(list.querySelectorAll('[data-reorder-handle]')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Add mapping' }) as HTMLButtonElement).disabled).toBe(true);
  } finally {
    readOnlyView.unmount();
  }

  // 2. Saving in progress
  let releaseSave!: () => void;
  api.on('PATCH', '/management/auth-files/fields', () => new Promise((resolve) => {
    releaseSave = () => resolve(json({ status: 'ok', file: FILE, fields }));
  }));
  const savingView = renderWithOmc(
    <AuthFileDetailDrawer file={FILE} open canEdit initialSection="configuration" onClose={vi.fn()} onSaved={vi.fn()} onDownload={vi.fn()} />,
  );
  try {
    const list = await screen.findByTestId('credential-model-aliases-list');
    await waitFor(() => expect(list.querySelectorAll('[data-reorder-handle]')).toHaveLength(2));
    const note = await screen.findByLabelText('Note');
    fireEvent.change(note, { target: { value: 'Saving note' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(list.querySelectorAll('[data-reorder-handle]')).toHaveLength(0));
    expect((screen.getByRole('button', { name: 'Add mapping' }) as HTMLButtonElement).disabled).toBe(true);
    releaseSave();
    await waitFor(() => expect(list.querySelectorAll('[data-reorder-handle]')).toHaveLength(2));
  } finally {
    savingView.unmount();
  }
});

it('edits and saves global OAuth request-scoped error rules for Copilot in OAuthModelRulesDrawer', async () => {
  const api = installOmcApi({});
  serveProviderCatalog(api);
  let storedErrorRules: Record<string, unknown[]> = {
    copilot: [{ status: 400, match: ['context_length'], action: 'stop' }],
  };
  api.on('GET', '/management/auth-files/model-aliases', () => ({ aliases: {} }));
  api.on('GET', '/management/auth-files/excluded-models', () => ({ excluded_models: {} }));
  api.on('GET', '/management/auth-files/request-scoped-errors', () => ({
    request_scoped_errors: storedErrorRules,
  }));
  api.on('PATCH', '/management/auth-files/request-scoped-errors', (request) => {
    const body = request.body as { provider: string; rules: unknown[] };
    storedErrorRules = { ...storedErrorRules, [body.provider]: body.rules };
    return { status: 'ok', provider: body.provider, rules: body.rules };
  });
  const pendingSave = api.hold('PATCH', '/management/auth-files/request-scoped-errors');

  const onSaved = vi.fn();
  const view = renderWithOmc(
    <OAuthModelRulesDrawer
      open
      onClose={vi.fn()}
      onSaved={onSaved}
      providerOptions={['claude', 'codex', 'copilot']}
      initialProvider="copilot"
    />,
  );
  try {
    const errorsTab = await screen.findByTestId('oauth-model-rules-tab-errors');
    expect(errorsTab.textContent).toContain('1');
    fireEvent.click(errorsTab);

    const summary = await screen.findByTestId('oauth-error-rules-summary');
    expect(summary.textContent).toContain('1');

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const statusInput = await screen.findByLabelText('Rule 2: Status code') as HTMLInputElement;
    const matchInput = screen.getByLabelText('Rule 2: Pattern') as HTMLInputElement;
    fireEvent.change(statusInput, { target: { value: '429' } });
    // Whitespace-only pattern must surface inline OAuth validation without sending a request.
    fireEvent.change(matchInput, { target: { value: '   ' } });
    const saveButton = screen.getByTestId('oauth-model-rules-save') as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    fireEvent.click(saveButton);
    expect(await screen.findByText('A pattern cannot be empty')).toBeTruthy();
    expect(api.writes('/management/auth-files/request-scoped-errors')).toHaveLength(0);

    // Fix the pattern, submit, wait for the request to arrive, verify editor disables while saving, then release.
    fireEvent.change(matchInput, { target: { value: '  rate_limit_exceeded  ' } });
    fireEvent.click(saveButton);
    await pendingSave.arrived;
    await waitFor(() => expect(statusInput.disabled).toBe(true));
    expect(matchInput.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(true);
    pendingSave.release();

    await waitFor(() => expect(api.writes('/management/auth-files/request-scoped-errors')).toHaveLength(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.writes('/management/auth-files/request-scoped-errors')[0].body).toEqual({
      provider: 'copilot',
      rules: [
        { status: 400, match: ['context_length'], action: 'stop' },
        { status: 429, match: ['rate_limit_exceeded'], action: 'continue' },
      ],
    });
    await waitFor(() => expect(saveButton.disabled).toBe(true));
    await waitFor(() => expect((screen.getByLabelText('Rule 2: Status code') as HTMLInputElement).disabled).toBe(false));
  } finally {
    view.unmount();
  }
});
