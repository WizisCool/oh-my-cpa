import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConfigDraft } from '../src/components/config/useConfigDraft';
import { renderGroupPanel } from '../src/components/config/configSectionRenderers';
import { ConfigDirtyBar } from '../src/components/config/ConfigDirtyBar';
import { ConfigOutline } from '../src/components/config/ConfigOutline';
import { ALL_CONFIG_FIELDS, CONFIG_GROUPS } from '../src/types/configSchema';
import { I18nProvider, useT } from '../src/i18n';
import { PayloadRulesEditor, type PayloadRulesEditorProps } from '../src/components/config/PayloadRulesEditor';
import { readPayloadCategory } from '../src/components/config/payloadRules';
import { api } from '../src/api/client';
import type { ConfigScalarsResponse } from '../src/types/configManagement';
import { createTestQueryClient, renderWithOmc } from './support/render';

const TEST_SCALARS_STUB: Pick<ConfigScalarsResponse, 'scalars' | 'supported_keys'> = {
  scalars: {
    proxy_url: '',
    ws_auth: false,
    force_model_prefix: false,
    debug: false,
    request_log: false,
    logging_to_file: false,
    logs_max_total_size_mb: 0,
    error_logs_max_files: 0,
    routing_strategy: 'round-robin',
    request_retry: 0,
    max_retry_interval: 0,
    max_retry_credentials: 0,
    usage_statistics_enabled: false,
  },
  supported_keys: [],
};

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
    expect(headers).toHaveLength(6);
    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(Array(6).fill('false'));

    const getDefaultHeader = () => screen.getByRole('button', { name: /^Default Rules/ });
    rerender(<PayloadSurface doc={doc} onDocChange={onDocChange} validateTrigger={1} />);
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('true');
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it('adds, validates, reorders, toggles target all vs positions, and preserves empty deletion in Replacement Rules', async () => {
    const patchSpy = vi.spyOn(api, 'patchConfig');
    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: 'requests: {}\n' });
    renderWithOmc(<ConfigPayloadDraft />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe('requests: {}\n'));

      const replaceHeader = screen.getByRole('button', { name: /^Replacement Rules/ });
      fireEvent.click(replaceHeader);
      fireEvent.click(screen.getByTestId('payload-replace-add-rule'));

      // Model & protocol selection
      const panel = replaceHeader.closest('[data-slot="accordion-item"]')!;
      const modelInput = panel.querySelector('input[placeholder*="Model name"]') as HTMLInputElement;
      fireEvent.change(modelInput, { target: { value: '*' } });

      // Invalid position (0 and non-numeric) surfaces validation error on blur
      const posInput = screen.getByTestId('payload-replace-positions-0') as HTMLInputElement;
      fireEvent.change(posInput, { target: { value: '0, abc' } });
      fireEvent.blur(posInput);
      expect(screen.getByRole('alert').textContent).toContain('greater than or equal to 1');

      // Remove invalid chips, then enter valid positions 1, 2
      fireEvent.click(screen.getByTestId('payload-replace-pos-remove-0-0'));
      fireEvent.click(screen.getByTestId('payload-replace-invpos-remove-0-0'));
      fireEvent.change(posInput, { target: { value: '1, 2' } });
      fireEvent.blur(posInput);
      expect(screen.getByTestId('payload-draft').textContent).toContain('positions:');

      // Add two replacement entries including an empty deletion ""
      fireEvent.change(screen.getByTestId('payload-replace-from-0-0'), { target: { value: 'you are hero' } });
      fireEvent.change(screen.getByTestId('payload-replace-to-0-0'), { target: { value: 'you are fool' } });
      fireEvent.click(screen.getByTestId('payload-replace-add-entry-0'));
      fireEvent.change(screen.getByTestId('payload-replace-from-0-1'), { target: { value: 'remove this phrase' } });
      fireEvent.change(screen.getByTestId('payload-replace-to-0-1'), { target: { value: '' } });

      const draftBeforeReorder = screen.getByTestId('payload-draft').textContent ?? '';
      expect(draftBeforeReorder).toContain('remove this phrase: ""');
      expect(draftBeforeReorder.indexOf('you are hero')).toBeLessThan(draftBeforeReorder.indexOf('remove this phrase'));

      // Reorder replacement rows preserves user order in serialized YAML
      fireEvent.click(screen.getByTestId('payload-replace-up-0-1'));
      const draftAfterReorder = screen.getByTestId('payload-draft').textContent ?? '';
      expect(draftAfterReorder.indexOf('remove this phrase')).toBeLessThan(draftAfterReorder.indexOf('you are hero'));

      // Toggling all switch ON clears positions and writes all: true without positions
      const allSwitch = screen.getByTestId('payload-replace-all-0');
      fireEvent.click(allSwitch);
      const draftWithAll = screen.getByTestId('payload-draft').textContent ?? '';
      expect(draftWithAll).toContain('all: true');
      expect(draftWithAll).not.toContain('positions:');
      expect((screen.getByTestId('payload-replace-positions-0') as HTMLInputElement).disabled).toBe(true);

      // Toggling all switch OFF re-enables positions input
      fireEvent.click(allSwitch);
      expect((screen.getByTestId('payload-replace-positions-0') as HTMLInputElement).disabled).toBe(false);

      // Add a second rule and reorder rules: rule order is preserved in YAML
      fireEvent.click(screen.getByTestId('payload-replace-add-rule'));
      const ruleCards = screen.getAllByTestId(/^payload-replace-rule-card-/);
      expect(ruleCards).toHaveLength(2);
      const secondCard = ruleCards[1];
      const secondModel = secondCard.querySelector('input[placeholder*="Model name"]') as HTMLInputElement;
      fireEvent.change(secondModel, { target: { value: 'claude-*' } });
      fireEvent.click(screen.getByTestId('payload-replace-all-1'));
      fireEvent.change(screen.getByTestId('payload-replace-from-1-0'), { target: { value: 'second rule' } });
      fireEvent.change(screen.getByTestId('payload-replace-to-1-0'), { target: { value: 'updated' } });

      fireEvent.click(screen.getByTestId('payload-replace-rule-up-1'));
      const reorderedRuleYaml = screen.getByTestId('payload-draft').textContent ?? '';
      expect(reorderedRuleYaml.indexOf('claude-*')).toBeLessThan(reorderedRuleYaml.indexOf('remove this phrase'));
    } finally {
      patchSpy.mockRestore();
      client.clear();
    }
  });

  it('opens invalid replace category on validation and surfaces mutual-exclusivity conflict', () => {
    const conflictDoc = parseDocument(`requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          all: true
          positions: [1]
        replacements:
          - "hello": ""
`);
    const onValidationChange = vi.fn();
    const { rerender } = render(
      <PayloadSurface doc={conflictDoc} onDocChange={vi.fn()} onValidationChange={onValidationChange} validateTrigger={0} />,
    );
    const replaceHeader = screen.getByRole('button', { name: /^Replacement Rules/ });
    expect(replaceHeader.getAttribute('aria-expanded')).toBe('false');
    expect(onValidationChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ category: 'replace', messageKey: 'cfg.payload_replace_target_conflict' }),
      ]),
    );

    rerender(
      <PayloadSurface doc={conflictDoc} onDocChange={vi.fn()} onValidationChange={onValidationChange} validateTrigger={1} />,
    );
    expect(replaceHeader.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('mutually exclusive');
  });

  it('retains invalid position chips entered on a clean rule and commits pending position text on Ctrl+S before saving', async () => {
    const cleanYaml = `requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - hello: world
`;
    const patchSpy = vi.spyOn(api, 'patchConfig').mockResolvedValue({
      status: 'ok',
      safe_yaml: cleanYaml.replace('- 1', '- 1\n            - 2'),
      revision: 'fixture-r2',
    });
    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: cleanYaml });
    renderWithOmc(<ConfigPayloadDraft />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(cleanYaml));

      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      const posInput = screen.getByTestId('payload-replace-positions-0') as HTMLInputElement;

      // Entering `bad,` on a clean rule targeting `[1]` preserves the invalid token in serialized YAML,
      // preventing baseline semantic equality from reparsing and discarding the invalid chip & alert.
      fireEvent.change(posInput, { target: { value: 'bad,' } });
      expect(screen.getByTestId('payload-replace-invpos-remove-0-0')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain('greater than or equal to 1');
      expect(screen.getByTestId('payload-draft').textContent).toContain('bad');

      // Removing `bad` restores the clean baseline.
      fireEvent.click(screen.getByTestId('payload-replace-invpos-remove-0-0'));
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(cleanYaml));
      expect(screen.queryByRole('alert')).toBeNull();

      // Typing invalid pending text `bad` without Enter/blur and pressing Ctrl+S commits & blocks save.
      fireEvent.change(posInput, { target: { value: 'bad' } });
      fireEvent.keyDown(posInput, { key: 's', ctrlKey: true });
      await waitFor(() => expect(screen.getByTestId('payload-replace-invpos-remove-0-0')).toBeTruthy());
      const alertsText = screen.getAllByRole('alert').map((el) => el.textContent).join('\n');
      expect(alertsText).toContain('greater than or equal to 1');
      expect(alertsText).toContain('Payload has 1 issues to fix');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(patchSpy).not.toHaveBeenCalled();

      // Clean up `bad` chip, then type `2` and press Ctrl+S before Enter or blur.
      fireEvent.click(screen.getByTestId('payload-replace-invpos-remove-0-0'));
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(cleanYaml));

      fireEvent.change(posInput, { target: { value: '2' } });
      fireEvent.keyDown(posInput, { key: 's', ctrlKey: true });

      const confirmDialog = await screen.findByRole('dialog');
      const confirmBtn = Array.from(confirmDialog.querySelectorAll('button')).pop()!;
      await act(async () => {
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
      const [changes] = patchSpy.mock.calls[0];
      expect(JSON.stringify(changes)).toContain('"positions":[1,2]');
    } finally {
      patchSpy.mockRestore();
      client.clear();
    }
  });

  it('preserves pending position text across server refreshes and in-flight save readbacks, clearing only on discard', async () => {
    const baseYaml = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - " ": ""
`;
    const refreshedYaml = `server:
  port: 8318
requests:
  payload:
    replace:
      - models:
          - name: claude-*
        target:
          role: user
          all: true
        replacements:
          - foo: bar
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - " ": ""
`;
    const getScalarsSpy = vi.spyOn(api, 'getConfigScalars').mockResolvedValue({
      ...TEST_SCALARS_STUB,
      revision: 'fixture-r3',
      safe_yaml: refreshedYaml.replace('port: 8318', 'port: 8319'),
    });
    let resolvePatch: ((res: { status: string; safe_yaml: string; revision: string }) => void) | null = null;
    const patchSpy = vi.spyOn(api, 'patchConfig').mockImplementation(
      () => new Promise((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
    const portUpdateRef: React.MutableRefObject<((port: number) => void) | null> = { current: null };
    function RefreshablePayloadDraft() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port')!;
      saveRef.current = draft.saveConfig;
      portUpdateRef.current = (port) => draft.updateFieldInDoc(portField, port);
      return (
        <>
          {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
          <button type="button" data-testid="payload-discard" onClick={draft.handleDiscardChanges}>discard</button>
          <ConfigDirtyBar isDirty={draft.isDirty} isSaving={false} onSave={draft.saveConfig} onDiscard={draft.handleDiscardChanges} />
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: baseYaml });
    renderWithOmc(<RefreshablePayloadDraft />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(baseYaml));

      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));

      // 1) Typing pending text `2` without separator/blur keeps `2` across a concurrent server refresh
      // (even when the server prepends a new rule shifting our rule from index 0 to index 1).
      const posInput0 = screen.getByTestId('payload-replace-positions-0') as HTMLInputElement;
      fireEvent.change(posInput0, { target: { value: '2' } });
      expect(posInput0.value).toBe('2');

      act(() => {
        client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r2', safe_yaml: refreshedYaml });
      });

      await waitFor(() => expect(screen.getByTestId('payload-replace-rule-card-1')).toBeTruthy());
      expect((screen.getByTestId('payload-replace-positions-1') as HTMLInputElement).value).toBe('2');
      expect((screen.getByTestId('payload-replace-positions-0') as HTMLInputElement).value).toBe('');

      // 2) Explicit discard clears pending text and exits dirty state.
      fireEvent.click(screen.getByTestId('payload-discard'));
      await waitFor(() => expect((screen.getByTestId('payload-replace-positions-1') as HTMLInputElement).value).toBe(''));
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();

      // 3) An in-flight save's readback also preserves pending text typed while the save was pending.
      act(() => {
        portUpdateRef.current?.(8319);
      });
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('port: 8319'));

      let savePromise: Promise<unknown> = Promise.resolve();
      act(() => {
        savePromise = saveRef.current?.() ?? Promise.resolve();
      });
      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));

      // Type `3` while the save is still in flight.
      const rule1Input = screen.getByTestId('payload-replace-positions-1') as HTMLInputElement;
      fireEvent.change(rule1Input, { target: { value: '3' } });
      expect(rule1Input.value).toBe('3');

      await act(async () => {
        resolvePatch?.({
          status: 'ok',
          safe_yaml: refreshedYaml.replace('port: 8318', 'port: 8319'),
          revision: 'fixture-r3',
        });
        await savePromise;
      });

      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('port: 8319'));
      expect((screen.getByTestId('payload-replace-positions-1') as HTMLInputElement).value).toBe('3');
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(false);
    } finally {
      getScalarsSpy.mockRestore();
      patchSpy.mockRestore();
      client.clear();
    }
  });

  it('moves unmatched pending position text to the unresolved notice on concurrent rule replacement, blocks save, and clears on discard', async () => {
    const initialYaml = `server:
  port: 8319
requests:
  payload:
    replace:
      - models:
          - name: claude-*
        target:
          role: user
          all: true
        replacements:
          - foo: bar
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - " ": ""
`;
    const replacedSameModels = `server:
  port: 8321
requests:
  payload:
    replace:
      - models:
          - name: claude-*
        target:
          role: user
          all: true
        replacements:
          - foo: bar
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 5
        replacements:
          - X: Y
`;
    const patchSpy = vi.spyOn(api, 'patchConfig');
    const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
    function UnresolvedDraftHost() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      saveRef.current = draft.saveConfig;
      return (
        <>
          {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
          <ConfigDirtyBar isDirty={draft.isDirty} isSaving={false} onSave={draft.saveConfig} onDiscard={draft.handleDiscardChanges} />
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r3', safe_yaml: initialYaml });
    renderWithOmc(<UnresolvedDraftHost />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(initialYaml));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));

      fireEvent.change(screen.getByTestId('payload-replace-positions-1'), { target: { value: '3' } });
      expect((screen.getByTestId('payload-replace-positions-1') as HTMLInputElement).value).toBe('3');

      act(() => {
        client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r4', safe_yaml: replacedSameModels });
      });

      await waitFor(() => expect((screen.getByTestId('payload-replace-positions-1') as HTMLInputElement).value).toBe(''));
      const unresolvedNotice = await screen.findByTestId('payload-replace-unresolved-notice');
      expect(unresolvedNotice.textContent).toContain('3');
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' })).toBeTruthy();

      // Save is blocked while the unresolved pending edit remains.
      await act(async () => {
        await saveRef.current?.();
      });
      expect(patchSpy).not.toHaveBeenCalled();

      // Explicitly discarding the unresolved item clears it and exits dirty state.
      fireEvent.click(within(unresolvedNotice).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.queryByTestId('payload-replace-unresolved-notice')).toBeNull());
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    } finally {
      patchSpy.mockRestore();
      client.clear();
    }
  });

  it('rejects unsupported target.role without silent retargeting and supports explicit role fix', async () => {
    const doc = parseDocument(`requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: assistant
          positions: [1]
        replacements:
          - hello: world
`);
    const onDocChange = vi.fn();
    let latestIssues: Array<{ messageKey: string }> = [];
    render(
      <PayloadSurface
        doc={doc}
        onDocChange={onDocChange}
        onValidationChange={(issues) => {
          latestIssues = issues;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
    expect(screen.getByTestId('payload-replace-role-tag-0').textContent).toBe('role: assistant');
    expect(screen.getByText("Target role must be 'user'")).toBeTruthy();
    expect(latestIssues.map((i) => i.messageKey)).toContain('cfg.payload_replace_role_invalid');

    // Editing a replacement must preserve role: assistant rather than silently rewriting to role: user.
    const toInput = screen.getByTestId('payload-replace-to-0-0') as HTMLInputElement;
    fireEvent.change(toInput, { target: { value: 'updated' } });
    fireEvent.blur(toInput);
    const listAfterRepEdit = readPayloadCategory(doc, 'replace') as Array<{ target: { role?: string } }>;
    expect(listAfterRepEdit[0].target.role).toBe('assistant');
    expect(latestIssues.map((i) => i.messageKey)).toContain('cfg.payload_replace_role_invalid');

    // Explicit click on "Set role: user" transitions the target role to user and clears the role issue.
    fireEvent.click(screen.getByTestId('payload-replace-fix-role-0'));
    expect(screen.getByTestId('payload-replace-role-tag-0').textContent).toBe('role: user');
    const listAfterRoleFix = readPayloadCategory(doc, 'replace') as Array<{ target: { role?: string } }>;
    expect(listAfterRoleFix[0].target.role).toBe('user');
    expect(latestIssues).toEqual([]);
  });

  it('retains payload validation issues across an in-flight save completion after the payload editor unmounts', async () => {
    const cleanYaml = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
`;
    const getScalarsSpy = vi.spyOn(api, 'getConfigScalars').mockResolvedValue({
      ...TEST_SCALARS_STUB,
      revision: 'fixture-r2',
      safe_yaml: cleanYaml.replace('port: 8317', 'port: 8318'),
    });
    let resolvePatch: ((res: { status: string; safe_yaml: string; revision: string }) => void) | null = null;
    const patchSpy = vi.spyOn(api, 'patchConfig').mockImplementation(
      () => new Promise((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
    const portUpdateRef: React.MutableRefObject<((port: number) => void) | null> = { current: null };
    const issueKeysRef: React.MutableRefObject<string[]> = { current: [] };

    function UnmountedSaveHost() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port')!;
      saveRef.current = draft.saveConfig;
      portUpdateRef.current = (port) => draft.updateFieldInDoc(portField, port);
      issueKeysRef.current = draft.payloadIssues.map((i) => i.messageKey);
      return (
        <>
          {draft.activeSection === 'payload' ? (
            renderGroupPanel(
              { ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t },
              group,
            )
          ) : (
            <div data-testid="connectivity-view" />
          )}
          <button type="button" data-testid="go-payload" onClick={() => draft.setActiveSection('payload')}>payload</button>
          <button type="button" data-testid="go-conn" onClick={() => draft.setActiveSection('connectivity')}>conn</button>
          <output data-testid="payload-draft">{draft.rawYaml}</output>
          <output data-testid="payload-issue-count">{String(draft.payloadIssues.length)}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: cleanYaml });
    renderWithOmc(<UnmountedSaveHost />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(cleanYaml));

      // Trigger an initial save on port change.
      act(() => {
        portUpdateRef.current?.(8318);
      });
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('port: 8318'));

      let firstSave: Promise<unknown> = Promise.resolve();
      act(() => {
        firstSave = saveRef.current?.() ?? Promise.resolve();
      });
      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));

      // While the first save is still in flight, navigate to Payload, type invalid position `abc`,
      // and navigate away to Connectivity so setActiveSection flushes `abc` and unmounts the editor.
      fireEvent.click(screen.getByTestId('go-payload'));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      fireEvent.change(screen.getByTestId('payload-replace-positions-0'), { target: { value: 'abc' } });
      fireEvent.click(screen.getByTestId('go-conn'));
      await waitFor(() => expect(screen.getByTestId('connectivity-view')).toBeTruthy());
      expect(issueKeysRef.current).toContain('cfg.payload_replace_positions_invalid');

      // Earlier save succeeds now; hasNewerDraft is true and PayloadRulesEditor is unmounted.
      await act(async () => {
        resolvePatch?.({
          status: 'ok',
          safe_yaml: cleanYaml.replace('port: 8317', 'port: 8318'),
          revision: 'fixture-r2',
        });
        await firstSave;
      });

      // Validation issue for `abc` MUST still be present and block a subsequent save.
      expect(Number(screen.getByTestId('payload-issue-count').textContent)).toBeGreaterThan(0);
      expect(issueKeysRef.current).toContain('cfg.payload_replace_positions_invalid');
      await act(async () => {
        await saveRef.current?.();
      });
      expect(patchSpy).toHaveBeenCalledTimes(1);
    } finally {
      getScalarsSpy.mockRestore();
      patchSpy.mockRestore();
      client.clear();
    }
  });

  it('clears discarded payload validation issues when switching to Source mode so subsequent source saves succeed', async () => {
    const initialYaml = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - " ": ""
`;
    const refreshedYaml = `server:
  port: 8318
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 5
        replacements:
          - X: Y
`;
    const getSourceSpy = vi.spyOn(api, 'getConfigSource').mockResolvedValue({
      yaml: refreshedYaml,
      size_bytes: refreshedYaml.length,
      revision: 'fixture-r2',
    });
    const updateSourceSpy = vi.spyOn(api, 'updateConfigSource').mockResolvedValue({
      status: 'ok',
      yaml: refreshedYaml.replace('8318', '8320'),
      revision: 'fixture-r3',
    });
    const getScalarsSpy = vi.spyOn(api, 'getConfigScalars').mockResolvedValue({
      ...TEST_SCALARS_STUB,
      revision: 'fixture-r3',
      safe_yaml: refreshedYaml.replace('8318', '8320'),
    });

    const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
    const switchRef: React.MutableRefObject<((m: 'visual' | 'source') => Promise<void>) | null> = { current: null };
    const setRawRef: React.MutableRefObject<((y: string) => void) | null> = { current: null };

    function SourceSwitchHost() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      saveRef.current = draft.saveConfig;
      switchRef.current = draft.handleViewModeChange;
      setRawRef.current = draft.setRawYaml;
      return (
        <>
          {draft.viewMode === 'visual' ? (
            renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)
          ) : (
            <div data-testid="source-mode-view" />
          )}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
          <output data-testid="payload-issue-count">{String(draft.payloadIssues.length)}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: initialYaml });
    renderWithOmc(<SourceSwitchHost />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(initialYaml));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      fireEvent.change(screen.getByTestId('payload-replace-positions-0'), { target: { value: '3' } });

      act(() => {
        client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r2', safe_yaml: refreshedYaml });
      });

      await screen.findByTestId('payload-replace-unresolved-notice');
      await waitFor(() => expect(Number(screen.getByTestId('payload-issue-count').textContent)).toBeGreaterThan(0));

      let switchPromise: Promise<void> = Promise.resolve();
      act(() => {
        switchPromise = switchRef.current?.('source') ?? Promise.resolve();
      });

      const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
      fireEvent.click(confirmBtn);
      await act(async () => {
        await switchPromise;
      });

      await screen.findByTestId('source-mode-view');
      expect(screen.getByTestId('payload-issue-count').textContent).toBe('0');

      act(() => {
        setRawRef.current?.(refreshedYaml.replace('8318', '8320'));
      });
      await act(async () => {
        await saveRef.current?.();
      });
      expect(updateSourceSpy).toHaveBeenCalledTimes(1);
    } finally {
      getSourceSpy.mockRestore();
      updateSourceSpy.mockRestore();
      getScalarsSpy.mockRestore();
      client.clear();
    }
  });

  it('does not retain visual payload issues when typing in Source mode during an in-flight source save', async () => {
    const initialYaml = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
        replacements:
          - a: b
`;
    const editedSourceYaml = `server:
  port: 8318
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          all: true
        replacements:
          - a: b
`;
    const getSourceSpy = vi.spyOn(api, 'getConfigSource').mockResolvedValue({
      yaml: initialYaml,
      size_bytes: initialYaml.length,
      revision: 'fixture-r1',
    });
    let resolveUpdate: ((res: { status: string; yaml: string; revision: string }) => void) | null = null;
    const updateSourceSpy = vi.spyOn(api, 'updateConfigSource').mockImplementation(
      () => new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const getScalarsSpy = vi.spyOn(api, 'getConfigScalars').mockResolvedValue({
      ...TEST_SCALARS_STUB,
      revision: 'fixture-r2',
      safe_yaml: editedSourceYaml,
    });

    const saveRef: React.MutableRefObject<(() => Promise<unknown>) | null> = { current: null };
    const switchRef: React.MutableRefObject<((m: 'visual' | 'source') => Promise<void>) | null> = { current: null };
    const setRawRef: React.MutableRefObject<((y: string) => void) | null> = { current: null };

    function SourceInFlightHost() {
      const draft = useConfigDraft();
      saveRef.current = draft.saveConfig;
      switchRef.current = draft.handleViewModeChange;
      setRawRef.current = draft.setRawYaml;
      return (
        <>
          <output data-testid="view-mode">{draft.viewMode}</output>
          <output data-testid="payload-issue-count">{String(draft.payloadIssues.length)}</output>
          <output data-testid="is-saving">{String(draft.saveMutation.isPending)}</output>
          <output data-testid="is-dirty">{String(draft.isDirty)}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: initialYaml });
    renderWithOmc(<SourceInFlightHost />, { client, isStrict: true });
    try {
      await act(async () => {
        await switchRef.current?.('source');
      });
      expect(screen.getByTestId('view-mode').textContent).toBe('source');

      act(() => {
        setRawRef.current?.(editedSourceYaml);
      });
      await waitFor(() => expect(screen.getByTestId('is-dirty').textContent).toBe('true'));
      let firstSave: Promise<unknown> = Promise.resolve();
      act(() => {
        firstSave = saveRef.current?.() ?? Promise.resolve();
      });
      await waitFor(() => expect(updateSourceSpy).toHaveBeenCalledTimes(1));

      // Keep typing in Source mode while save is in flight; `hasNewerDraft` becomes true.
      act(() => {
        setRawRef.current?.(`${editedSourceYaml}debug: true\n`);
      });

      await act(async () => {
        resolveUpdate?.({ status: 'ok', yaml: editedSourceYaml, revision: 'fixture-r2' });
        await firstSave;
      });

      await waitFor(() => expect(screen.getByTestId('is-saving').textContent).toBe('false'));
      expect(screen.getByTestId('payload-issue-count').textContent).toBe('0');
      expect(screen.getByTestId('is-dirty').textContent).toBe('true');
      updateSourceSpy.mockResolvedValueOnce({ status: 'ok', yaml: `${editedSourceYaml}debug: true\n`, revision: 'fixture-r3' });
      await act(async () => {
        await saveRef.current?.();
      });
      expect(updateSourceSpy).toHaveBeenCalledTimes(2);
    } finally {
      getSourceSpy.mockRestore();
      updateSourceSpy.mockRestore();
      getScalarsSpy.mockRestore();
      client.clear();
    }
  });

  it('preserves active IME composition on a replacement rule when a clean baseline refresh prepends another rule', async () => {
    const initialA = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - oldA: newA
`;
    const prependedBA = `server:
  port: 8318
requests:
  payload:
    replace:
      - models:
          - name: model-b
        target:
          role: user
          all: true
        replacements:
          - oldB: newB
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - oldA: newA
`;

    function CleanComposeHost() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      return (
        <>
          {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: initialA });
    renderWithOmc(<CleanComposeHost />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(initialA));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));

      const toInputA = screen.getByTestId('payload-replace-to-0-0') as HTMLTextAreaElement;
      fireEvent.compositionStart(toInputA);
      typeComposing(toInputA, 'zhong', true);

      // Clean background refresh prepends Rule B before Rule A while composition is active.
      act(() => {
        client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r2', safe_yaml: prependedBA });
      });

      await waitFor(() => expect(screen.getByTestId('payload-replace-rule-card-1')).toBeTruthy());
      const movedToInputA = screen.getByTestId('payload-replace-to-1-0') as HTMLTextAreaElement;
      expect(movedToInputA.value).toBe('zhong');
      expect((screen.getByTestId('payload-replace-to-0-0') as HTMLTextAreaElement).value).toBe('newB');

      // Completing composition must commit into Rule A (now card 1), not Rule B (card 0).
      typeComposing(movedToInputA, '中文新值', true);
      fireEvent.compositionEnd(movedToInputA);

      const savedDoc = parseDocument(screen.getByTestId('payload-draft').textContent ?? '');
      const replaceList = savedDoc.getIn(['requests', 'payload', 'replace']) as {
        toJSON: () => Array<{ replacements: Array<Record<string, string>> }>;
      };
      expect(replaceList.toJSON()[0].replacements).toEqual([{ oldB: 'newB' }]);
      expect(replaceList.toJSON()[1].replacements).toEqual([{ oldA: '中文新值' }]);
    } finally {
      client.clear();
    }
  });

  it('retains pending notification when inline onPendingChange callback changes identity', async () => {
    const doc = parseDocument(`requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions: [1]
        replacements:
          - a: b
`);
    const states: boolean[] = [];
    const flushRef: React.MutableRefObject<(() => boolean) | null> = { current: null };
    function InlinePendingHost() {
      const [pending, setPending] = React.useState(false);
      return (
        <>
          <PayloadSurface
            doc={doc}
            onDocChange={vi.fn()}
            onPendingChange={(next) => {
              states.push(next);
              setPending(next);
            }}
            flushPendingRef={flushRef}
          />
          <output data-testid="inline-pending">{String(pending)}</output>
        </>
      );
    }

    render(<InlinePendingHost />);
    fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
    fireEvent.change(screen.getByTestId('payload-replace-positions-0'), { target: { value: '2' } });
    expect(screen.getByTestId('inline-pending').textContent).toBe('true');
    expect(states[states.length - 1]).toBe(true);
    expect(typeof flushRef.current).toBe('function');
  });

  it('commits pending position text across section and search transitions that unmount the editor', async () => {
    const cleanYaml = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
`;
    function TransitionHost() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      const showPayload = draft.searchQuery ? false : draft.activeSection === 'payload';
      return (
        <>
          {showPayload ? (
            renderGroupPanel(
              { ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t },
              group,
            )
          ) : (
            <div data-testid="other-view" />
          )}
          <button type="button" data-testid="go-payload" onClick={() => draft.setActiveSection('payload')}>payload</button>
          <button type="button" data-testid="go-conn" onClick={() => draft.setActiveSection('connectivity')}>conn</button>
          <button type="button" data-testid="set-search" onClick={() => draft.setSearchQuery('port')}>search</button>
          <button type="button" data-testid="clear-search" onClick={() => draft.setSearchQuery('')}>clear</button>
          <output data-testid="payload-draft">{draft.rawYaml}</output>
          <output data-testid="payload-dirty">{String(draft.isDirty)}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: cleanYaml });
    renderWithOmc(<TransitionHost />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(cleanYaml));

      fireEvent.click(screen.getByTestId('go-payload'));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      fireEvent.change(screen.getByTestId('payload-replace-positions-0'), { target: { value: '2' } });
      expect(screen.getByTestId('payload-dirty').textContent).toBe('true');

      // Section transition unmounts PayloadRulesEditor without blurring input: `2` must commit & stay dirty.
      fireEvent.click(screen.getByTestId('go-conn'));
      await waitFor(() => expect(screen.getByTestId('other-view')).toBeTruthy());
      expect(screen.getByTestId('payload-dirty').textContent).toBe('true');
      const afterSectionDoc = parseDocument(screen.getByTestId('payload-draft').textContent ?? '');
      expect((afterSectionDoc.getIn(['requests', 'payload', 'replace']) as { toJSON: () => Array<{ target: { positions: number[] } }> }).toJSON()[0].target.positions).toEqual([1, 2]);

      // Return to payload, enter `3`, then transition via search without blurring: `3` must commit too.
      fireEvent.click(screen.getByTestId('go-payload'));
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      fireEvent.change(screen.getByTestId('payload-replace-positions-0'), { target: { value: '3' } });
      fireEvent.click(screen.getByTestId('set-search'));
      await waitFor(() => expect(screen.getByTestId('other-view')).toBeTruthy());
      expect(screen.getByTestId('payload-dirty').textContent).toBe('true');
      const afterSearchDoc = parseDocument(screen.getByTestId('payload-draft').textContent ?? '');
      expect((afterSearchDoc.getIn(['requests', 'payload', 'replace']) as { toJSON: () => Array<{ target: { positions: number[] } }> }).toJSON()[0].target.positions).toEqual([1, 2, 3]);
    } finally {
      client.clear();
    }
  });

  it('resolves advanced model modal edits by identity after a background reorder', async () => {
    const initialAB = `server:
  port: 8317
requests:
  payload:
    replace:
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
      - models:
          - name: model-b
        target:
          role: user
          positions:
            - 2
        replacements:
          - c: d
`;
    const reorderedBA = `server:
  port: 8318
requests:
  payload:
    replace:
      - models:
          - name: model-b
        target:
          role: user
          positions:
            - 2
        replacements:
          - c: d
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
`;

    const portUpdateRef: React.MutableRefObject<((port: number) => void) | null> = { current: null };
    function ModalRebaseDraft() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port')!;
      portUpdateRef.current = (port) => draft.updateFieldInDoc(portField, port);
      return (
        <>
          {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
        </>
      );
    }

    const client = createTestQueryClient();
    client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: initialAB });
    renderWithOmc(<ModalRebaseDraft />, { client, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(initialAB));

      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));

      // Make an unrelated local edit so adoptBaseline rebases instead of discarding.
      act(() => {
        portUpdateRef.current?.(8319);
      });
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('port: 8319'));

      // Open Advanced Model Conditions on rule B (currently index 1).
      const cardB = screen.getByTestId('payload-replace-rule-card-1');
      fireEvent.click(within(cardB).getByRole('button', { name: 'Advanced' }));

      const modal = await screen.findByRole('dialog');
      expect(modal.textContent).toContain('model-b');
      const addBtns = within(modal).getAllByRole('button', { name: /Add Condition/ });
      fireEvent.click(addBtns[0]);
      fireEvent.change(within(modal).getByPlaceholderText('Key / Path'), { target: { value: 'X-Rule' } });
      fireEvent.change(within(modal).getByPlaceholderText('Value / Pattern'), { target: { value: 'from-b' } });

      // Background refresh reorders [A, B] -> [B, A] while modal is open.
      act(() => {
        client.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r2', safe_yaml: reorderedBA });
      });

      await waitFor(() => {
        const card0Input = screen.getByTestId('payload-replace-rule-card-0').querySelector('input.payload-model-input') as HTMLInputElement;
        expect(card0Input.value).toBe('model-b');
      });

      // Confirm modal: must update model-b (now index 0), NOT model-a.
      const confirmBtn = Array.from(modal.querySelectorAll('button')).pop()!;
      fireEvent.click(confirmBtn);

      const savedDoc = parseDocument(screen.getByTestId('payload-draft').textContent ?? '');
      const replaceList = savedDoc.getIn(['requests', 'payload', 'replace']) as { toJSON: () => Array<{ models: Array<{ name: string; headers?: Record<string, string> }> }> };
      const rulesJson = replaceList.toJSON();
      expect(rulesJson[0].models[0].name).toBe('model-b');
      expect(rulesJson[0].models[0].headers).toEqual({ 'X-Rule': 'from-b' });
      expect(rulesJson[1].models[0].name).toBe('model-a');
      expect(rulesJson[1].models[0].headers).toBeUndefined();
    } finally {
      client.clear();
    }
  });

  it('requires explicit discard when a background refresh removes or modifies the open advanced modal target, and preserves drafts across unrelated refreshes', async () => {
    const initialAB = `server:
  port: 8317
requests:
  payload:
    default:
      - models:
          - name: gpt-4o
        params:
          temperature: 0.2
    replace:
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
      - models:
          - name: model-b
        target:
          role: user
          positions:
            - 2
        replacements:
          - c: d
`;
    const refreshedUnrelated = initialAB.replace('port: 8317', 'port: 8318');
    const onlyA = `server:
  port: 8320
requests:
  payload:
    default:
      - models:
          - name: gpt-4o
        params:
          temperature: 0.2
    replace:
      - models:
          - name: model-a
        target:
          role: user
          positions:
            - 1
        replacements:
          - a: b
`;

    const portUpdateRef: React.MutableRefObject<((port: number) => void) | null> = { current: null };
    function ModalDisappearDraft() {
      const draft = useConfigDraft();
      const t = useT();
      const group = CONFIG_GROUPS.find((g) => g.variant === 'payload-builder')!;
      const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port')!;
      portUpdateRef.current = (port) => draft.updateFieldInDoc(portField, port);
      return (
        <>
          {renderGroupPanel({ ...draft, doc: draft.docRef.current, configuredKeyCount: 0, navigate: () => {}, searchMatchedGroups: [], t }, group)}
          <output data-testid="payload-draft">{draft.rawYaml}</output>
        </>
      );
    }

    const client2 = createTestQueryClient();
    client2.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r1', safe_yaml: initialAB });
    renderWithOmc(<ModalDisappearDraft />, { client: client2, isStrict: true });
    try {
      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toBe(initialAB));

      // 1) Open Advanced Model Conditions on a `default` rule, edit conditions, and receive an
      // unrelated server port refresh: modal and unsaved `advDraft` stay open and intact.
      const defaultHeader = screen.getByRole('button', { name: /^Default Rules/ });
      fireEvent.click(defaultHeader);
      const defaultPanel = defaultHeader.closest('[data-slot="accordion-item"]') as HTMLElement;
      fireEvent.click(within(defaultPanel).getByRole('button', { name: 'Advanced' }));

      const defaultModal = await screen.findByRole('dialog');
      fireEvent.click(within(defaultModal).getAllByRole('button', { name: /Add Condition/ })[0]);
      fireEvent.change(within(defaultModal).getByPlaceholderText('Key / Path'), { target: { value: 'X-Keep' } });
      fireEvent.change(within(defaultModal).getByPlaceholderText('Value / Pattern'), { target: { value: 'yes' } });

      act(() => {
        client2.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r2', safe_yaml: refreshedUnrelated });
      });

      await waitFor(() => expect(screen.getByTestId('payload-draft').textContent).toContain('port: 8318'));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect((within(screen.getByRole('dialog')).getByPlaceholderText('Key / Path') as HTMLInputElement).value).toBe('X-Keep');
      expect((within(screen.getByRole('dialog')).getByPlaceholderText('Value / Pattern') as HTMLInputElement).value).toBe('yes');
      expect(screen.queryByTestId('payload-adv-stale-notice')).toBeNull();

      // Confirming applies the preserved `advDraft` to `default`.
      const confirmDefaultBtn = Array.from(screen.getByRole('dialog').querySelectorAll('button')).pop()!;
      fireEvent.click(confirmDefaultBtn);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByTestId('payload-draft').textContent).toContain('X-Keep: yes');

      // 2) Open Advanced Model Conditions on replace rule B, then remove rule B via refresh:
      // modal remains open with stale warning + disabled Confirm until explicitly discarded.
      fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));
      const cardB2 = screen.getByTestId('payload-replace-rule-card-1');
      fireEvent.click(within(cardB2).getByRole('button', { name: 'Advanced' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();

      act(() => {
        client2.setQueryData(['management-config'], { scalars: {}, revision: 'fixture-r3', safe_yaml: onlyA });
      });

      const staleNotice = await screen.findByTestId('payload-adv-stale-notice');
      expect(staleNotice).toBeTruthy();
      const staleDialog = screen.getByRole('dialog');
      const okBtn = within(staleDialog).getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
      expect(okBtn.disabled).toBe(true);
      fireEvent.click(within(staleDialog).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      client2.clear();
    }
  });

  it('preserves multiline replacement text, non-string null destinations on source-only edits, and invalid all/list shapes until explicitly corrected', async () => {
    const doc = parseDocument(`requests:
  payload:
    replace:
      - models:
          - name: "*"
        target:
          role: user
          all: "true"
          positions: [1]
        replacements:
          - hello: null
          - old: "first\\nsecond"
      - models:
          - name: claude-*
        target:
          role: user
          all: true
        replacements:
          oldMap: newMap
`);
    let latestIssues: Array<{ messageKey: string }> = [];
    render(
      <PayloadSurface
        doc={doc}
        onDocChange={vi.fn()}
        onValidationChange={(issues) => {
          latestIssues = issues;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Replacement Rules/ }));

    // 1) Malformed `all: "true"` and non-array `replacements` surface immediately and survive unrelated edits.
    expect(screen.getByTestId('payload-replace-all-tag-0').textContent).toBe('all: true');
    expect(latestIssues.map((i) => i.messageKey)).toEqual(
      expect.arrayContaining([
        'cfg.payload_replace_all_invalid',
        'cfg.payload_replace_dest_invalid',
        'cfg.payload_replace_list_invalid',
      ]),
    );

    // Editing source only on `{ hello: null }` preserves `null` destination instead of turning into `""`.
    const fromInput0 = screen.getByTestId('payload-replace-from-0-0') as HTMLTextAreaElement;
    fireEvent.change(fromInput0, { target: { value: 'hello2' } });
    fireEvent.blur(fromInput0);

    // Editing multiline destination `"first\nsecond"` preserves literal line breaks.
    const toInput1 = screen.getByTestId('payload-replace-to-0-1') as HTMLTextAreaElement;
    expect(toInput1.value).toBe('first\nsecond');
    fireEvent.change(toInput1, { target: { value: 'first\nsecond!' } });
    fireEvent.blur(toInput1);

    const midList = readPayloadCategory(doc, 'replace') as Array<Record<string, unknown>>;
    expect(midList[0].target).toEqual({ role: 'user', all: 'true', positions: [1] });
    expect(midList[0].replacements).toEqual([{ hello2: null }, { old: 'first\nsecond!' }]);
    expect(midList[1].replacements).toEqual({ oldMap: 'newMap' });

    // Explicit fixes clear each malformed shape on demand.
    fireEvent.click(screen.getByTestId('payload-replace-fix-all-0'));
    fireEvent.change(screen.getByTestId('payload-replace-to-0-0'), { target: { value: 'fixed' } });
    fireEvent.click(screen.getByTestId('payload-replace-add-entry-1'));
    fireEvent.change(screen.getByTestId('payload-replace-from-1-0'), { target: { value: 'k' } });
    fireEvent.change(screen.getByTestId('payload-replace-to-1-0'), { target: { value: 'v' } });

    const fixedList = readPayloadCategory(doc, 'replace') as Array<Record<string, unknown>>;
    expect(fixedList[0].target).toEqual({ role: 'user', positions: [1] });
    expect(fixedList[0].replacements).toEqual([{ hello2: 'fixed' }, { old: 'first\nsecond!' }]);
    expect(fixedList[1].replacements).toEqual([{ k: 'v' }]);
    expect(latestIssues).toEqual([]);
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
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(false);
  } finally { client.clear(); }
});

function typeComposing(input: HTMLInputElement | HTMLTextAreaElement, value: string, isComposingText: boolean) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
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
