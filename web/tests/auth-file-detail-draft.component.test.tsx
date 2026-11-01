import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const FILE: ManagementAuthFile = { recovery_supported: true, name: 'claude.json', auth_index: 'exact-claude', type: 'claude', provider: 'claude', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, note: 'Original note' };
const FIELDS = { proxy_url: 'socks5h://%5Bredacted%5D@proxy.example.test:1080', name: FILE.name, note: FILE.note, disable_cooling: false, websockets: false, using_api: false, excluded_models: [], model_aliases: [] };
function mountDetail(holdSave?: Promise<void>) {
  const onClose = vi.fn(); const onSaved = vi.fn(); const onRecover = vi.fn();
  const api = installOmcApi({ authFiles: [{ file: FILE, fields: FIELDS }] });
  if (holdSave) {
    const save = api.hold('PATCH', '/management/auth-files/fields');
    void holdSave.then(() => save.release());
  }
  let updateExternalDraft: (hasDraft: boolean) => void = () => {};
  let suspendDraftRemoval = () => {};
  let releaseDraftRemoval!: () => void;
  const heldRender = new Promise<void>(resolve => { releaseDraftRemoval = resolve; });
  const suspendedRender = vi.fn();
  function RenderGate({ shouldSuspend }: { shouldSuspend: boolean }) {
    if (shouldSuspend) {
      suspendedRender();
      throw heldRender;
    }
    return null;
  }
  function Harness() {
    const [hasDraft, setHasDraft] = React.useState(false);
    const [warmupDraft, setWarmupDraft] = React.useState('');
    const [shouldSuspend, setShouldSuspend] = React.useState(false);
    updateExternalDraft = setHasDraft;
    suspendDraftRemoval = () => React.startTransition(() => { setHasDraft(false); setShouldSuspend(true); });
    return <React.Suspense fallback={<span>Draft update pending</span>}><AuthFileDetailDrawer file={FILE} open canEdit onRecover={onRecover} initialSection="warmup" hasExternalDraft={hasDraft} onClose={onClose} onSaved={onSaved} onDownload={() => {}}
      warmupContent={<label>Warmup draft<input aria-label="Warmup draft" value={warmupDraft} onChange={event => { setWarmupDraft(event.target.value); setHasDraft(Boolean(event.target.value)); }} /></label>} /><RenderGate shouldSuspend={shouldSuspend} /></React.Suspense>;
  }
  const surface = renderWithOmc(<Harness />, { isStrict: true });
  return { ...surface, onClose, onSaved, onRecover, suspendedRender,
    get writes() { return api.writes('/management/auth-files/fields').map(request => request.body); },
    updateExternalDraft: (hasDraft: boolean) => updateExternalDraft(hasDraft),
    suspendDraftRemoval: () => suspendDraftRemoval(), releaseDraftRemoval };
}
async function editWarmupAndOpenConfiguration() {
  fireEvent.change(await screen.findByLabelText('Warmup draft'), { target: { value: 'Unsaved warmup policy' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
  const note = await screen.findByLabelText('Note');
  await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
  await waitFor(() => expect((note as HTMLTextAreaElement).value).toBe(FILE.note));
  return note;
}
it('keeps a warmup draft when saving actual credential field changes', async () => {
  const surface = mountDetail();
  const note = await editWarmupAndOpenConfiguration();
  fireEvent.change(note, { target: { value: 'Updated note' } });
  const saveButton = screen.getByRole('button', { name: 'Save Fields' });
  await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(saveButton);
  await waitFor(() => expect(surface.writes).toHaveLength(1));
  await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
  expect(surface.onClose).not.toHaveBeenCalled();
  expect(surface.writes).toHaveLength(1);
  expect(surface.writes[0]).not.toHaveProperty('proxy_url');
  expect((await screen.findByLabelText('Warmup draft') as HTMLInputElement).value).toBe('Unsaved warmup policy');
  surface.unmount();
});
it('keeps a warmup draft when normalized field edits produce an empty patch', async () => {
  const surface = mountDetail();
  await editWarmupAndOpenConfiguration();
  const excludedModels = screen.getByLabelText('Excluded Models');
  fireEvent.change(excludedModels, { target: { value: '  \n  ' } });
  const button = screen.getByRole('button', { name: 'Save Fields' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(surface.writes).toHaveLength(0);
  expect(surface.onClose).not.toHaveBeenCalled();
  surface.unmount();
});

it('rechecks the latest external draft flag when an in-flight field save completes', async () => {
  let releaseSave!: () => void;
  const holdSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const surface = mountDetail(holdSave);
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Saved concurrently' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(surface.writes).toHaveLength(1));
    act(() => surface.updateExternalDraft(true));
    releaseSave();
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.onClose).not.toHaveBeenCalled();
  } finally {
    releaseSave(); surface.unmount();
  }
});

it('uses committed draft state when a concurrent draft removal suspends during a field save', async () => {
  let releaseSave!: () => void;
  const holdSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const surface = mountDetail(holdSave);
  try {
    const note = await editWarmupAndOpenConfiguration();
    fireEvent.change(note, { target: { value: 'Saved during suspended render' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(surface.writes).toHaveLength(1));
    act(() => surface.suspendDraftRemoval());
    await waitFor(() => expect(surface.suspendedRender).toHaveBeenCalled());
    expect(screen.queryByText('Draft update pending')).toBeNull();
    releaseSave();
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.onClose).not.toHaveBeenCalled();
    expect((await screen.findByLabelText('Warmup draft') as HTMLInputElement).value).toBe('Unsaved warmup policy');
  } finally {
    surface.unmount(); releaseSave(); surface.releaseDraftRemoval();
  }
});

it('preserves credential status when only its name is saved', async () => {
  const file = { ...FILE, status: 'error' };
  const api = installOmcApi({ authFiles: [{ file, fields: FIELDS }] });
  api.on('PUT', '/management/auth-files/display-name', () => ({ status: 'ok', display_name: 'Team seat', display_name_version: 1 }));
  const onSaved = vi.fn();
  renderWithOmc(<AuthFileDetailDrawer file={file} open canEdit initialSection="configuration" onClose={vi.fn()} onSaved={onSaved} onDownload={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText('Prefix') as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team seat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Fields' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(onSaved.mock.calls[0][0]).toEqual({ ...file, display_name: 'Team seat', display_name_version: 1 });
  expect(api.writes('/management/auth-files/fields')).toHaveLength(0);
});

it('requires explicit discard before leaving an external draft for credential recovery', async () => {
  const surface = mountDetail();
  try {
    fireEvent.change(await screen.findByLabelText('Warmup draft'), { target: { value: 'Unsaved warmup policy' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Quota' }));
    fireEvent.click(surface.baseElement.querySelector('[data-credential-recover]')!);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(surface.onRecover).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(surface.onRecover).not.toHaveBeenCalled();
    expect((await screen.findByLabelText('Warmup draft') as HTMLInputElement).value).toBe('Unsaved warmup policy');
  } finally { surface.unmount(); }
});

it('keeps field edits dirty when recovery leaves the drawer open', async () => {
  const surface = mountDetail();
  try {
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const note = await screen.findByLabelText('Note') as HTMLTextAreaElement;
    await waitFor(() => expect(note.value).toBe(FILE.note));
    fireEvent.change(note, { target: { value: 'Field draft before refused recovery' } });
    const save = screen.getByRole('button', { name: 'Save Fields' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(screen.getByRole('tab', { name: 'Quota' }));
    fireEvent.click(surface.baseElement.querySelector('[data-credential-recover]')!);
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await act(async () => { fireEvent.click(confirm); });
    expect(surface.onRecover).toHaveBeenCalledOnce();
    expect(surface.onClose).not.toHaveBeenCalled();
    expect(note.value).toBe('Field draft before refused recovery');
    expect(save.disabled).toBe(false);
    expect(surface.writes).toHaveLength(0);
  } finally { surface.unmount(); }
});
