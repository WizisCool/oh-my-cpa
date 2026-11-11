import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConfigDraft } from '../src/components/config/useConfigDraft';
import { renderGroupPanel } from '../src/components/config/configSectionRenderers';
import { ConfigDirtyBar } from '../src/components/config/ConfigDirtyBar';
import { CONFIG_GROUPS } from '../src/types/configSchema';
import { I18nProvider, useT } from '../src/i18n';
import { PayloadRulesEditor, type PayloadRulesEditorProps } from '../src/components/config/PayloadRulesEditor';
import { api } from '../src/api/client';
import { createTestQueryClient, renderWithOmc } from './support/render';

const POPULATED_YAML = `requests:
  payload:
    default:
      - models:
          - name: model-one
        params:
          temperature: 0.5
`;

function PayloadSurface(props: PayloadRulesEditorProps) {
  return <React.StrictMode><I18nProvider><PayloadRulesEditor {...props} /></I18nProvider></React.StrictMode>;
}

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
});

describe('payload rule disclosures', () => {
  it('opens populated rules collapsed, preserves disclosure across external updates, and opens invalid categories on validation', () => {
    const doc = parseDocument(POPULATED_YAML.replace('model-one', '""'));
    const onDocChange = vi.fn();
    const { container, rerender } = render(<PayloadSurface doc={doc} onDocChange={onDocChange} validateTrigger={0} />);
    const headers = Array.from(container.querySelectorAll('.payload-collapse .ant-collapse-header'));
    expect(headers).toHaveLength(5);
    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(Array(5).fill('false'));

    const getDefaultHeader = () => screen.getByRole('button', { name: /^Default Rules/ });
    rerender(<PayloadSurface doc={doc} onDocChange={onDocChange} validateTrigger={1} />);
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('true');
    expect(onDocChange).not.toHaveBeenCalled();
  });
});

function ConfigPayloadDraft() {
  const draft = useConfigDraft();
  const t = useT();
  const group = CONFIG_GROUPS.find(group => group.variant === 'payload-builder')!;
  return <>
    {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
    <output data-testid="payload-draft">{draft.rawYaml}</output>
    <ConfigDirtyBar isDirty={draft.isDirty} isSaving={false} onSave={() => {}} onDiscard={() => {}} />
  </>;
}

it('adding a raw rule updates the actual configuration draft and exposes its save action', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: 'requests: {}\n' });
  try {
    const { container } = render(<React.StrictMode><I18nProvider><QueryClientProvider client={client}><AntdApp><ConfigPayloadDraft /></AntdApp></QueryClientProvider></I18nProvider></React.StrictMode>);
    await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe('requests: {}\n'));
    const header = screen.getByRole('button', { name: /^Override Raw Rules/ });
    fireEvent.click(header);
    const panel = header.closest('.ant-collapse-item')!;
    fireEvent.click(panel.querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('override-raw'));
    expect(container.querySelectorAll('.payload-rule-card')).toHaveLength(1);
    const save = document.querySelector<HTMLButtonElement>('.config-dirty-btn-save');
    expect(save).not.toBeNull();
    expect(save?.disabled).toBe(false);
  } finally { client.clear(); }
});

function typeComposing(input: HTMLInputElement, value: string, isComposingText: boolean) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  const event = new Event('input', { bubbles: true });
  Object.defineProperty(event, 'isComposing', { value: isComposingText });
  fireEvent(input, event);
}

function ConfigProviderMapDraft({ saveRef }: { saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> }) {
  const draft = useConfigDraft();
  const t = useT();
  const group = CONFIG_GROUPS.find((item) => item.id === 'grp_antigravity_behavior')!;
  saveRef.current = draft.saveConfig;
  return <>
    {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
    <output data-testid="provider-map-draft">{draft.rawYaml}</output>
    <output data-testid="provider-map-errors">{String(draft.hasConfigErrors)}</output>
    <button type="button" data-testid="provider-map-discard" onClick={draft.handleDiscardChanges}>discard</button>
  </>;
}

it('edits sensitive-word replacement rows with interior spaces, IME composition, invalid-save blocking, and discard resync', async () => {
  const patchSpy = vi.spyOn(api, 'patchConfig');
  const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
  const client = createTestQueryClient();
  client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: 'server:\n  port: 8317\n' });
  const { container } = renderWithOmc(<ConfigProviderMapDraft saveRef={saveRef} />, { client, isStrict: true });
  try {
    await waitFor(() => expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n'));

    fireEvent.click(screen.getByTestId('string-map-add-antigravitySensitiveWordsReplace'));
    expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n');

    // Provisional IME composition text stays local across background refreshes until compositionEnd commits it.
    const valInput0 = screen.getByTestId('string-map-value-antigravitySensitiveWordsReplace-0') as HTMLInputElement;
    fireEvent.compositionStart(valInput0);
    typeComposing(valInput0, 'zhong', true);
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    act(() => {
      client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1b', safe_yaml: 'server:\n  port: 8317\n' });
    });
    expect(valInput0.value).toBe('zhong');
    typeComposing(valInput0, 'First', true);
    fireEvent.compositionEnd(valInput0);

    // Entering a replacement without a target key marks config errors without writing a partial map.
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');
    expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n');
    await act(async () => {
      await saveRef.current?.();
    });
    expect(patchSpy).not.toHaveBeenCalled();

    const keyInput0 = screen.getByTestId('string-map-key-antigravitySensitiveWordsReplace-0') as HTMLInputElement;
    fireEvent.change(keyInput0, { target: { value: 'Claude ' } });
    expect(keyInput0.value).toBe('Claude ');
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    fireEvent.change(keyInput0, { target: { value: 'Claude Code' } });
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('Claude Code: First');

    // A duplicate target key blocks saving and leaves the previously valid replacement intact in the draft.
    fireEvent.click(screen.getByTestId('string-map-add-antigravitySensitiveWordsReplace'));
    fireEvent.change(screen.getByTestId('string-map-value-antigravitySensitiveWordsReplace-1'), { target: { value: 'Second' } });
    fireEvent.change(screen.getByTestId('string-map-key-antigravitySensitiveWordsReplace-1'), { target: { value: 'Claude Code' } });
    expect(container.querySelector('.string-map-error')?.textContent).toContain('Claude Code');
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('Claude Code: First');
    expect(screen.getByTestId('provider-map-draft').textContent).not.toContain('Second');
    await act(async () => {
      await saveRef.current?.();
    });
    expect(patchSpy).not.toHaveBeenCalled();

    // If a refreshed baseline adds a concurrent phrase while an incomplete row is retained,
    // completing the row preserves both the draft entry and the concurrent baseline entry.
    fireEvent.click(screen.getByTestId('provider-map-discard'));
    await waitFor(() => expect(screen.queryByTestId('string-map-key-antigravitySensitiveWordsReplace-0')).toBeNull());
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n');

    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r2',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-words-replace:\n        a: one\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('string-map-key-antigravitySensitiveWordsReplace-0') as HTMLInputElement).value).toBe('a'));

    fireEvent.click(screen.getByTestId('string-map-add-antigravitySensitiveWordsReplace'));
    fireEvent.change(screen.getByTestId('string-map-value-antigravitySensitiveWordsReplace-1'), { target: { value: 'two' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');

    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r3',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-words-replace:\n        a: one\n        concurrent: kept\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('string-map-key-antigravitySensitiveWordsReplace-2') as HTMLInputElement).value).toBe('concurrent'));

    fireEvent.change(screen.getByTestId('string-map-key-antigravitySensitiveWordsReplace-1'), { target: { value: 'b' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('a: one');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('b: two');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('concurrent: kept');

    // Also verify an active IME composition on an existing row survives a background value change on that row.
    const existingValInput0 = screen.getByTestId('string-map-value-antigravitySensitiveWordsReplace-0') as HTMLInputElement;
    fireEvent.compositionStart(existingValInput0);
    typeComposing(existingValInput0, 'xin', true);
    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r4',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-words-replace:\n        a: updated\n        b: two\n        concurrent: kept\n',
      });
    });
    expect(existingValInput0.value).toBe('xin');
    typeComposing(existingValInput0, 'final', true);
    fireEvent.compositionEnd(existingValInput0);
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('a: final');
  } finally {
    patchSpy.mockRestore();
  }
});
