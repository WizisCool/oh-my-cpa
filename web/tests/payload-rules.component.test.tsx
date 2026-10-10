import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { I18nProvider } from '../src/i18n';
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
