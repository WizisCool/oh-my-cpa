import React from 'react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';

const FILE: ManagementAuthFile = { name: 'claude.json', auth_index: 'exact-claude', type: 'claude', provider: 'claude', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, note: 'Original note' };
const FIELDS = { name: FILE.name, note: FILE.note, disable_cooling: false, websockets: false, using_api: false, excluded_models: [], model_aliases: [] };
beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});
function mountDetail(holdSave?: Promise<void>) {
  const onClose = vi.fn(); const onSaved = vi.fn();
  const writes: Record<string, unknown>[] = [];
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
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    const url = new URL(path, 'http://127.0.0.1');
    let result: unknown;
    if (url.pathname.endsWith('/auth-files/safe-fields')) result = FIELDS;
    else if (url.pathname.endsWith('/auth-files/fields')) {
      const body = JSON.parse(options.body as string);
      writes.push(body);
      await holdSave;
      result = { status: 'ok', file: { ...FILE, note: body.note }, fields: { ...FIELDS, note: body.note } };
    } else {
      throw new Error(`Unexpected detail request: ${url.pathname}`);
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  function Harness() {
    const [hasDraft, setHasDraft] = React.useState(false);
    const [warmupDraft, setWarmupDraft] = React.useState('');
    const [shouldSuspend, setShouldSuspend] = React.useState(false);
    updateExternalDraft = setHasDraft;
    suspendDraftRemoval = () => React.startTransition(() => { setHasDraft(false); setShouldSuspend(true); });
    return <React.Suspense fallback={<span>Draft update pending</span>}><AuthFileDetailDrawer file={FILE} open canEdit hasExternalDraft={hasDraft} onClose={onClose} onSaved={onSaved} onDownload={() => {}}
      quotaContent={<label>Warmup draft<input aria-label="Warmup draft" value={warmupDraft} onChange={event => { setWarmupDraft(event.target.value); setHasDraft(Boolean(event.target.value)); }} /></label>} /><RenderGate shouldSuspend={shouldSuspend} /></React.Suspense>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const surface = render(<React.StrictMode><App><QueryClientProvider client={client}><I18nProvider><Harness /></I18nProvider></QueryClientProvider></App></React.StrictMode>);
  return { ...surface, client, onClose, onSaved, writes, suspendedRender,
    updateExternalDraft: (hasDraft: boolean) => updateExternalDraft(hasDraft),
    suspendDraftRemoval: () => suspendDraftRemoval(), releaseDraftRemoval };
}
async function editWarmupAndOpenConfiguration() {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Warmup draft' }), { target: { value: 'Unsaved warmup policy' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
  const note = await screen.findByRole('textbox', { name: 'Note' });
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Prefix' }) as HTMLInputElement).disabled).toBe(false));
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
  fireEvent.click(screen.getByRole('tab', { name: 'Quota' }));
  expect((await screen.findByRole('textbox', { name: 'Warmup draft' }) as HTMLInputElement).value).toBe('Unsaved warmup policy');
  surface.unmount(); surface.client.clear();
});
it('keeps a warmup draft when normalized field edits produce an empty patch', async () => {
  const surface = mountDetail();
  await editWarmupAndOpenConfiguration();
  const excludedModels = screen.getByRole('textbox', { name: 'Excluded Models' });
  fireEvent.change(excludedModels, { target: { value: '  \n  ' } });
  const button = screen.getByRole('button', { name: 'Save Fields' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(surface.writes).toHaveLength(0);
  expect(surface.onClose).not.toHaveBeenCalled();
  surface.unmount(); surface.client.clear();
});

it('rechecks the latest external draft flag when an in-flight field save completes', async () => {
  let releaseSave!: () => void;
  const holdSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const surface = mountDetail(holdSave);
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Prefix' }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Saved concurrently' } });
    const saveButton = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(() => expect(surface.writes).toHaveLength(1));
    act(() => surface.updateExternalDraft(true));
    releaseSave();
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.onClose).not.toHaveBeenCalled();
  } finally {
    releaseSave(); surface.unmount(); surface.client.clear();
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
    fireEvent.click(screen.getByRole('tab', { name: 'Quota' }));
    expect((await screen.findByRole('textbox', { name: 'Warmup draft' }) as HTMLInputElement).value).toBe('Unsaved warmup policy');
  } finally {
    surface.unmount(); surface.client.clear(); releaseSave(); surface.releaseDraftRemoval();
  }
});
