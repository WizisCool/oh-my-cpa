import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi, type OmcApi } from './support/omcApi';

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
