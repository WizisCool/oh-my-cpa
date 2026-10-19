import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginLogo } from '../src/components/plugins/PluginParts';
import { buildNavGroups } from '../src/components/common/navigation';
import type { PluginPageEntry } from '../src/components/plugins/pluginPages';

const SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path stroke="currentColor" d="M2 2L22 22"/></svg>');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('plugin artwork', () => {
  it.each([SVG, 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'])('renders SVG as an isolated theme-coloured mask', (logo) => {
    const { container } = render(<PluginLogo logo={logo} />);
    const glyph = container.querySelector<HTMLElement>('[data-plugin-logo="svg"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.style.maskImage).toContain(logo);
    expect(container.querySelector('img')).toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses the same SVG rendering for navigation entries', () => {
    const entry = { route: '/plugin-pages/test/0', navLabel: 'Test', logo: SVG } as PluginPageEntry;
    const icon = buildNavGroups([entry]).find((group) => group.key === 'plugins')!.items.at(-1)!.icon;
    const { container } = render(<>{icon}</>);
    expect(container.querySelector('.app-menu-plugin-logo[data-plugin-logo="svg"]')).not.toBeNull();
  });

  it('keeps raster artwork and recovers when a failed source changes', () => {
    const { container, rerender } = render(<PluginLogo logo={PNG} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(PNG);
    fireEvent.error(image);
    expect(container.querySelector('[data-plugin-logo="fallback"]')).not.toBeNull();
    rerender(<PluginLogo logo={SVG} />);
    expect(container.querySelector('[data-plugin-logo="svg"]')).not.toBeNull();
  });

  it('falls back for a broken SVG and detaches its load observer when replaced', () => {
    const images: Array<{ src: string; onerror: (() => void) | null }> = [];
    vi.stubGlobal('Image', class {
      src = '';
      onerror = null;
      constructor() { images.push(this); }
    });
    const { container, rerender } = render(<PluginLogo logo={SVG} />);
    expect(images[0].src).toBe(SVG);
    act(() => images[0].onerror?.());
    expect(container.querySelector('[data-plugin-logo="fallback"]')).not.toBeNull();
    expect(images[0].onerror).toBeNull();
    rerender(<PluginLogo logo={`${SVG} `} />);
    expect(container.querySelector('[data-plugin-logo="svg"]')).not.toBeNull();
    rerender(<PluginLogo logo={PNG} />);
    expect(images[1].onerror).toBeNull();
    expect(container.querySelector('img')!.getAttribute('src')).toBe(PNG);
  });

  it.each([undefined, 'https://example.test/logo.svg', '/logo.svg', 'javascript:alert(1)', 'data:text/html,<svg/>', 'data:image/svg+xml'])('uses the generic glyph for unusable input: %s', (logo) => {
    const { container } = render(<PluginLogo logo={logo} />);
    expect(container.querySelector('[data-plugin-logo="fallback"] svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('never inserts plugin-provided SVG markup into the document', () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://example.test"/></foreignObject></svg>';
    const { container } = render(<PluginLogo logo={`data:image/svg+xml,${encodeURIComponent(markup)}`} />);
    expect(container.querySelector('[data-plugin-logo="svg"]')).not.toBeNull();
    expect(container.querySelector('script, iframe, foreignObject, [onload]')).toBeNull();
  });
});
