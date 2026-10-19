import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it.each([
    { name: 'empty', yaml: 'requests: {}\n' },
    { name: 'populated', yaml: POPULATED_YAML },
  ])('opens $name rules with every category collapsed without changing the document', ({ yaml }) => {
    const doc = parseDocument(yaml);
    const originalYaml = doc.toString();
    const onDocChange = vi.fn();
    const { container } = render(<PayloadSurface doc={doc} onDocChange={onDocChange} />);
    const headers = Array.from(container.querySelectorAll('.payload-collapse .ant-collapse-header'));

    expect(headers).toHaveLength(5);
    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(Array(5).fill('false'));
    expect(doc.toString()).toBe(originalYaml);
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it('keeps the chosen disclosure state when an external document arrives', () => {
    const onDocChange = vi.fn();
    const { rerender } = render(<PayloadSurface doc={parseDocument(POPULATED_YAML)} onDocChange={onDocChange} />);
    const getDefaultHeader = () => screen.getByRole('button', { name: /^Default Rules/ });

    fireEvent.click(getDefaultHeader());
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('true');
    rerender(<PayloadSurface doc={parseDocument(POPULATED_YAML.replace('0.5', '0.7'))} onDocChange={onDocChange} />);
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(getDefaultHeader());
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('false');
    rerender(<PayloadSurface doc={parseDocument(POPULATED_YAML)} onDocChange={onDocChange} />);
    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('false');
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it('opens the invalid category after a save attempt', () => {
    const doc = parseDocument(POPULATED_YAML.replace('model-one', '""'));
    const onDocChange = vi.fn();
    const { rerender } = render(<PayloadSurface doc={doc} onDocChange={onDocChange} validateTrigger={0} />);
    const getDefaultHeader = () => screen.getByRole('button', { name: /^Default Rules/ });

    expect(getDefaultHeader().getAttribute('aria-expanded')).toBe('false');
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
