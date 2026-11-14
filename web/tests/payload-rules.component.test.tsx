import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConfigDraft } from '../src/components/config/useConfigDraft';
import { renderGroupPanel } from '../src/components/config/configSectionRenderers';
import { ConfigDirtyBar } from '../src/components/config/ConfigDirtyBar';
import { ConfigOutline } from '../src/components/config/ConfigOutline';
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
    const headers = Array.from(container.querySelectorAll('.payload-collapse [data-slot="accordion-trigger"]'));
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
    const { container } = render(<React.StrictMode><I18nProvider><QueryClientProvider client={client}><ConfigPayloadDraft /></QueryClientProvider></I18nProvider></React.StrictMode>);
    await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe('requests: {}\n'));
    const header = screen.getByRole('button', { name: /^Override Raw Rules/ });
    fireEvent.click(header);
    const panel = header.closest('[data-slot="accordion-item"]')!;
    fireEvent.click(panel.querySelector('[data-slot="accordion-panel"] button')!);
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

it('edits, reorders, validates, and rebases sensitive-patterns-replace rules', async () => {
  const patchSpy = vi.spyOn(api, 'patchConfig');
  const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
  const client = createTestQueryClient();
  client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: 'server:\n  port: 8317\n' });
  const { container } = renderWithOmc(<ConfigProviderMapDraft saveRef={saveRef} />, { client, isStrict: true });
  try {
    await waitFor(() => expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n'));

    fireEvent.click(screen.getByTestId('pattern-rules-add-antigravitySensitivePatternsReplace'));
    expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n');

    // Entering a replacement without a pattern marks errors and blocks saving without writing partial YAML.
    const rep0 = screen.getByTestId('pattern-rule-replacement-antigravitySensitivePatternsReplace-0') as HTMLInputElement;
    fireEvent.compositionStart(rep0);
    typeComposing(rep0, 'First', true);
    fireEvent.compositionEnd(rep0);
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');
    expect(screen.getByTestId('provider-map-draft').textContent).toBe('server:\n  port: 8317\n');
    await act(async () => {
      await saveRef.current?.();
    });
    expect(patchSpy).not.toHaveBeenCalled();

    // Unsupported Go RE2 lookaround also blocks saving.
    const pat0 = screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-0') as HTMLInputElement;
    fireEvent.change(pat0, { target: { value: 'foo(?=bar)' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');
    expect(container.querySelector('.pattern-rules-error')?.textContent).toContain('foo(?=bar)');
    await act(async () => {
      await saveRef.current?.();
    });
    expect(patchSpy).not.toHaveBeenCalled();

    // Valid Go RE2 with trailing space and empty deletion replacement commits cleanly.
    fireEvent.change(pat0, { target: { value: '(?i)claude ' } });
    fireEvent.change(rep0, { target: { value: '' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('pattern: "(?i)claude "');
    expect(screen.getByTestId('provider-map-draft').textContent).toContain('replacement: ""');

    // Adding a second rule and moving it up swaps the YAML sequence order.
    fireEvent.click(screen.getByTestId('pattern-rules-add-antigravitySensitivePatternsReplace'));
    fireEvent.change(screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-1'), { target: { value: 'second' } });
    fireEvent.change(screen.getByTestId('pattern-rule-replacement-antigravitySensitivePatternsReplace-1'), { target: { value: 'two' } });
    fireEvent.click(screen.getByTestId('pattern-rule-up-antigravitySensitivePatternsReplace-1'));
    const reorderedYaml = screen.getByTestId('provider-map-draft').textContent ?? '';
    expect(reorderedYaml.indexOf('pattern: second')).toBeLessThan(reorderedYaml.indexOf('pattern: "(?i)claude "'));

    // Discard clears draft state, then a concurrent baseline refresh preserves incomplete rows.
    fireEvent.click(screen.getByTestId('provider-map-discard'));
    await waitFor(() => expect(screen.queryByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-0')).toBeNull());
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');

    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r2',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-patterns-replace:\n        - pattern: a\n          replacement: one\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-0') as HTMLInputElement).value).toBe('a'));

    fireEvent.click(screen.getByTestId('pattern-rules-add-antigravitySensitivePatternsReplace'));
    fireEvent.change(screen.getByTestId('pattern-rule-replacement-antigravitySensitivePatternsReplace-1'), { target: { value: 'two' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('true');

    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r3',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-patterns-replace:\n        - pattern: a\n          replacement: one\n        - pattern: concurrent\n          replacement: kept\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-2') as HTMLInputElement).value).toBe(''));
    expect((screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-1') as HTMLInputElement).value).toBe('concurrent');

    fireEvent.change(screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-2'), { target: { value: 'b' } });
    expect(screen.getByTestId('provider-map-errors').textContent).toBe('false');
    const finalYaml = screen.getByTestId('provider-map-draft').textContent ?? '';
    expect(finalYaml).toContain('pattern: a');
    expect(finalYaml).toContain('pattern: concurrent');
    expect(finalYaml).toContain('pattern: b');

    // Starting IME composition on rule B keeps its target row even if a baseline refresh prepends rule C.
    fireEvent.click(screen.getByTestId('provider-map-discard'));
    await waitFor(() => expect(screen.queryByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-2')).toBeNull());
    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r4',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-patterns-replace:\n        - pattern: A\n          replacement: repA\n        - pattern: B\n          replacement: repB\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('pattern-rule-replacement-antigravitySensitivePatternsReplace-1') as HTMLInputElement).value).toBe('repB'));

    const repBInput = screen.getByTestId('pattern-rule-replacement-antigravitySensitivePatternsReplace-1') as HTMLInputElement;
    fireEvent.compositionStart(repBInput);
    typeComposing(repBInput, 'b-comp', true);

    act(() => {
      client.setQueryData(['management-config'], {
        scalars: {},
        revision: 'fixture-r5',
        safe_yaml: 'server:\n  port: 8317\noauth:\n  providers:\n    antigravity:\n      sensitive-patterns-replace:\n        - pattern: C\n          replacement: repC\n        - pattern: A\n          replacement: repA\n        - pattern: B\n          replacement: repB\n',
      });
    });
    await waitFor(() => expect((screen.getByTestId('pattern-rule-pattern-antigravitySensitivePatternsReplace-0') as HTMLInputElement).value).toBe('C'));
    // repBInput moved to index 2 and stayed attached to rule B.
    expect(repBInput.value).toBe('b-comp');
    typeComposing(repBInput, 'repB-final', true);
    fireEvent.compositionEnd(repBInput);

    const afterCompositionYaml = screen.getByTestId('provider-map-draft').textContent ?? '';
    expect(afterCompositionYaml).toContain('pattern: A\n          replacement: repA');
    expect(afterCompositionYaml).toContain('pattern: B\n          replacement: repB-final');
  } finally {
    patchSpy.mockRestore();
  }
});

describe('ConfigOutline', () => {
  it('stays mounted for single-group sections so switching sections preserves the rail, and hides when empty', () => {
    const { container, rerender } = renderWithOmc(
      <ConfigOutline entries={[{ id: 'grp_streaming_transport', label: 'Streaming Transport', count: 4, isDirty: false }]} />,
    );
    expect(container.querySelector('.config-outline')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Streaming Transport/ })).toBeTruthy();

    rerender(
      <ConfigOutline entries={[]} />,
    );
    expect(container.querySelector('.config-outline')).toBeNull();
  });
});
