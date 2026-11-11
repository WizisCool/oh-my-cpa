import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeBody, languageOf } from '../src/components/common/CodeBody';
import { ModelMarkdown } from '../src/components/workspace/ModelMarkdown';
import { renderWithOmc } from './support/render';

describe('CodeBody', () => {
  it('maps the fence names a model writes to a grammar and leaves the rest plain', () => {
    expect(languageOf('HTML')).toBe('xml');
    expect(languageOf('svg')).toBe('xml');
    expect(languageOf('sh')).toBe('bash');
    expect(languageOf('toml')).toBe('ini');
    expect(languageOf('brainfuck')).toBe('');
    expect(languageOf(undefined)).toBe('');
  });

  it('tokenises into highlight.js classes, so no application class styles a token', async () => {
    const { container } = render(<CodeBody lang="html" code={'<div class="card">hi</div>'} />);
    await waitFor(() => expect(container.querySelector('.hljs-tag')).not.toBeNull());

    // The console has its own `.tag` chip class; a token must never wear it.
    expect(container.querySelector('.hljs-tag')?.classList.contains('tag')).toBe(false);
    expect(container.querySelectorAll('pre')).toHaveLength(1);
  });

  it('highlights the CSS an HTML page embeds and leaves streaming text plain', async () => {
    const code = '<style>.card{color:red}</style>';
    const { container, rerender } = render(<CodeBody lang="html" code={code} />);
    await waitFor(() => expect(container.querySelector('.hljs-selector-class')).not.toBeNull());

    rerender(<CodeBody lang="html" code={code} isStreaming />);
    expect(container.querySelector('.hljs-selector-class')).toBeNull();
    expect(container.textContent).toContain('<style>.card{color:red}</style>');
  });
});

describe('ModelMarkdown', () => {
  it('renders GFM tables and inline code while escaping raw HTML and suppressing external image fetches', () => {
    const markdown = [
      'Use `omc serve` with **care**.',
      '',
      '| Model | Calls |',
      '| :--- | ---: |',
      '| gpt-5 | 42 |',
      '',
      '<script>window.__pwned = true</script>',
      '',
      '![](https://tracking.invalid/pixel.png)',
    ].join('\n');

    const { container } = renderWithOmc(
      <ModelMarkdown content={markdown} externalImageLabel="External image" />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>window.__pwned = true</script>');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('omc serve');

    const imageLink = screen.getByRole('link', { name: 'External image' });
    expect(imageLink.getAttribute('href')).toBe('https://tracking.invalid/pixel.png');
    expect(imageLink.getAttribute('target')).toBe('_blank');
  });

  it('keeps trailing streaming code fences plain until settled and offers HTML document preview when done', async () => {
    const htmlDoc = '<!doctype html><html><body><h1>Chart</h1></body></html>';
    const streamingDoc = `Intro\n\n\`\`\`json\n{"ok":true}\n\`\`\`\n\n\`\`\`html\n${htmlDoc}`;

    const { container, rerender } = renderWithOmc(
      <ModelMarkdown content={streamingDoc} isStreaming externalImageLabel="External image" />,
    );

    expect(container.querySelector('[data-streaming]')).not.toBeNull();
    expect(screen.queryByTestId('markdown-document-view')).toBeNull();
    // Closed earlier JSON block highlights while trailing unclosed HTML block stays plain.
    await waitFor(() => expect(container.querySelector('.hljs-attr')).not.toBeNull());
    expect(container.querySelector('.hljs-tag')).toBeNull();

    const settledDoc = `${streamingDoc}\n\`\`\``;
    rerender(<ModelMarkdown content={settledDoc} isStreaming={false} externalImageLabel="External image" />);

    expect(container.querySelector('[data-streaming]')).toBeNull();
    const previewToggle = await screen.findByTestId('markdown-document-view');
    await waitFor(() => expect(container.querySelector('.hljs-tag')).not.toBeNull());
    fireEvent.click(previewToggle);
    expect(container.querySelector('iframe')).not.toBeNull();
  });
});
