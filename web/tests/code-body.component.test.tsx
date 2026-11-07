import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeBody, languageOf } from '../src/components/common/CodeBody';

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
