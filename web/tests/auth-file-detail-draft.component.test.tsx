import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const FILE: ManagementAuthFile = { recovery_supported: true, name: 'claude.json', auth_index: 'exact-claude', type: 'claude', provider: 'claude', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, note: 'Original note' };
const FIELDS = { proxy_url: 'socks5h://%5Bredacted%5D@proxy.example.test:1080', name: FILE.name, note: FILE.note, disable_cooling: false, websockets: false, using_api: false, excluded_models: [], model_aliases: [] };

function mountDetail() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onRecover = vi.fn();
  const api = installOmcApi({ authFiles: [{ file: FILE, fields: FIELDS }] });
  function Harness() {
    const [hasDraft, setHasDraft] = React.useState(false);
    const [warmupDraft, setWarmupDraft] = React.useState('');
    return (
      <AuthFileDetailDrawer
        file={FILE}
        open
        canEdit
        onRecover={onRecover}
        initialSection="warmup"
        hasExternalDraft={hasDraft}
        onClose={onClose}
        onSaved={onSaved}
        onDownload={() => {}}
        warmupContent={
          <label>
            Warmup draft
            <input
              aria-label="Warmup draft"
              value={warmupDraft}
              onChange={event => {
                setWarmupDraft(event.target.value);
                setHasDraft(Boolean(event.target.value));
              }}
            />
          </label>
        }
      />
    );
  }
  const surface = renderWithOmc(<Harness />, { isStrict: true });
  return {
    ...surface,
    onClose,
    onSaved,
    onRecover,
    get writes() {
      return api.writes('/management/auth-files/fields').map(request => request.body);
    },
  };
}

it('keeps an external warmup draft when saving credential field changes and avoids sending redacted proxy URLs', async () => {
  const surface = mountDetail();
  try {
    fireEvent.change(await screen.findByLabelText('Warmup draft'), { target: { value: 'Unsaved warmup policy' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const note = await screen.findByLabelText('Note');
    await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(note, { target: { value: 'Updated note' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(surface.writes).toHaveLength(1));
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.onClose).not.toHaveBeenCalled();
    expect(surface.writes[0]).not.toHaveProperty('proxy_url');
    expect((await screen.findByLabelText('Warmup draft') as HTMLInputElement).value).toBe('Unsaved warmup policy');
  } finally {
    surface.unmount();
  }
});

it('preserves credential status when only its display name is saved', async () => {
  const file = { ...FILE, status: 'error' };
  const api = installOmcApi({ authFiles: [{ file, fields: FIELDS }] });
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
