import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { inertMarkup, isInlineImageURL, sanitizeExportStyle } from '../src/agent/openui/exportMarkup';
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

describe('OpenUI standalone HTML export sanitization', () => {
  it('strips non-inline assets, scripts, and hooks in inertMarkup while preserving data:image/ payloads, SVG fragments, and web links', () => {
    const inlinePNG = 'data:image/png;base64,AAAA';
    expect(isInlineImageURL(inlinePNG)).toBe(true);
    expect(isInlineImageURL('https://www.google.com/s2/favicons?sz=128&domain=example.test')).toBe(false);
    expect(isInlineImageURL('/api/v1/custom-icons/1/content')).toBe(false);
    expect(isInlineImageURL('blob:http://localhost/abc')).toBe(false);

    const host = document.createElement('div');
    host.innerHTML = [
      '<script>window.injected=1</script>',
      '<iframe src="https://evil.test"></iframe>',
      `<img id="inline" src="${inlinePNG}" srcset="${inlinePNG} 1x" alt="inline">`,
      `<img id="remote" src="https://www.google.com/s2/favicons?sz=128&domain=example.test" srcset="${inlinePNG} 1x, https://evil.test/2x.png 2x" onclick="evil()">`,
      '<img id="origin" src="/api/v1/custom-icons/1/content">',
      '<img id="blob" src="blob:http://localhost/abc">',
      '<video id="vid" poster="https://evil.test/poster.png"></video>',
      `<div id="styled" data-copy="1" style="background-image: url('https://evil.test/bg.png'), url('/api/x'), url(&quot;${inlinePNG}&quot;); clip-path: url(#chart-clip)"></div>`,
      '<svg><image id="svg-remote" href="https://evil.test/icon.svg" xlink:href="https://evil.test/icon.svg"></image><image id="svg-inline" href="data:image/png;base64,BBBB"></image><use id="svg-local-use" href="#icon-1" xlink:href="#icon-1"></use><use id="svg-remote-use" href="https://evil.test/sprite.svg#icon-1"></use></svg>',
      '<a id="web-link" href="https://example.test/docs">Docs</a>',
      '<a id="bad-link" href="javascript:alert(1)">Bad</a>',
      '<form id="frm" action="https://evil.test/submit"><button formaction="https://evil.test/btn">Go</button></form>',
    ].join('');

    const out = document.createElement('div');
    out.innerHTML = inertMarkup(host);

    expect(out.querySelector('script')).toBeNull();
    expect(out.querySelector('iframe')).toBeNull();
    expect(out.querySelector('#inline')?.getAttribute('src')).toBe(inlinePNG);
    expect(out.querySelector('#inline')?.getAttribute('srcset')).toBe(`${inlinePNG} 1x`);
    expect(out.querySelector('#remote')?.hasAttribute('src')).toBe(false);
    expect(out.querySelector('#remote')?.hasAttribute('srcset')).toBe(false);
    expect(out.querySelector('#remote')?.hasAttribute('onclick')).toBe(false);
    expect(out.querySelector('#origin')?.hasAttribute('src')).toBe(false);
    expect(out.querySelector('#blob')?.hasAttribute('src')).toBe(false);
    expect(out.querySelector('#vid')?.hasAttribute('poster')).toBe(false);

    const styled = out.querySelector('#styled');
    expect(styled?.hasAttribute('data-copy')).toBe(false);
    const styleText = styled?.getAttribute('style') ?? '';
    expect(styleText).not.toContain('evil.test');
    expect(styleText).not.toContain('/api/x');
    expect(styleText).toContain(inlinePNG);
    expect(styleText).toContain('url(#chart-clip)');
    expect(sanitizeExportStyle('background: url("https://evil.test/a\'b")')).toBe('background: none');

    expect(out.querySelector('#svg-remote')?.hasAttribute('href')).toBe(false);
    expect(out.querySelector('#svg-remote')?.hasAttribute('xlink:href')).toBe(false);
    expect(out.querySelector('#svg-inline')?.getAttribute('href')).toBe('data:image/png;base64,BBBB');
    expect(out.querySelector('#svg-local-use')?.getAttribute('href')).toBe('#icon-1');
    expect(out.querySelector('#svg-local-use')?.getAttribute('xlink:href')).toBe('#icon-1');
    expect(out.querySelector('#svg-remote-use')?.hasAttribute('href')).toBe(false);

    expect(out.querySelector('#web-link')?.getAttribute('href')).toBe('https://example.test/docs');
    expect(out.querySelector('#bad-link')?.hasAttribute('href')).toBe(false);
    expect(out.querySelector('#frm')?.hasAttribute('action')).toBe(false);
    expect(out.querySelector('#frm button')?.hasAttribute('formaction')).toBe(false);
  });
});
