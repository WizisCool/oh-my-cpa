import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { useProviderBranding } from '../src/hooks/useProviderBranding';
import { ProviderMark } from '../src/components/LobeIcon';
import { createTestQueryClient, renderWithOmc } from './support/render';
import { installOmcApi, json } from './support/omcApi';
import { PluginLogo } from '../src/components/plugins/PluginParts';
import { buildNavGroups } from '../src/components/common/navigation';
import type { PluginPageEntry } from '../src/components/plugins/pluginPages';

const SVG = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#2a78d6"/></svg>');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('plugin artwork', () => {
  it.each([SVG, 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'])('draws SVG artwork as an image rather than repainting it', (logo) => {
    const { container } = render(<PluginLogo logo={logo} />);
    const mark = container.querySelector<HTMLElement>('[data-plugin-logo="svg"]');
    expect(mark).not.toBeNull();
    expect(mark!.querySelector('img')!.getAttribute('src')).toBe(logo);
    expect(mark!.getAttribute('style')).toBeNull();
    expect(mark!.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses the same artwork rendering for navigation entries', () => {
    const entry = { route: '/plugin-pages/test/0', navLabel: 'Test', logo: SVG } as PluginPageEntry;
    const icon = buildNavGroups([entry]).find((group) => group.key === 'plugins')!.items.at(-1)!.icon;
    const { container } = render(<>{icon}</>);
    expect(container.querySelector('.app-menu-plugin-logo[data-plugin-logo="svg"] img')!.getAttribute('src')).toBe(SVG);
  });

  it('keeps raster artwork and recovers when a failed source changes', () => {
    const { container, rerender } = render(<PluginLogo logo={PNG} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(PNG);
    fireEvent.error(image);
    expect(container.querySelector('[data-plugin-logo="fallback"]')).not.toBeNull();
    rerender(<PluginLogo logo={SVG} />);
    expect(container.querySelector('[data-plugin-logo="svg"] img')!.getAttribute('src')).toBe(SVG);
  });

  it('falls back for a broken SVG and recovers when the artwork is republished', () => {
    const { container, rerender } = render(<PluginLogo logo={SVG} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('[data-plugin-logo="fallback"]')).not.toBeNull();
    rerender(<PluginLogo logo={`${SVG} `} />);
    expect(container.querySelector('[data-plugin-logo="svg"] img')).not.toBeNull();
  });

  it.each([undefined, 'https://example.test/logo.svg', '/logo.svg', 'javascript:alert(1)', 'data:text/html,<svg/>', 'data:image/svg+xml'])('uses the generic glyph for unusable input: %s', (logo) => {
    const { container } = render(<PluginLogo logo={logo} />);
    expect(container.querySelector('[data-plugin-logo="fallback"] svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('never inserts plugin-provided SVG markup into the document', () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://example.test"/></foreignObject></svg>';
    const { container } = render(<PluginLogo logo={`data:image/svg+xml,${encodeURIComponent(markup)}`} />);
    expect(container.querySelector('[data-plugin-logo="svg"] img')).not.toBeNull();
    expect(container.querySelector('script, iframe, foreignObject, [onload]')).toBeNull();
  });
});

describe('provider artwork', () => {
  it('retains a verified provider identity while metadata revalidation is unknown', async () => {
    const api = installOmcApi();
    const client = createTestQueryClient();
    client.setQueryData(['management-providers-sanitized'], { providers: [{ id: 'compat-0', family: 'openai-compatibility', name: 'Relay', upstream_name: 'plugin-relay' }], total: 1 });
    client.setQueryData(['management-plugins'], { plugins: [] });
    client.setQueryData(['preferences'], {});
    const pending = api.hold('GET', '/management/providers');
    const view = renderHook(() => useProviderBranding(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    try {
      await pending.arrived;
      expect(view.result.current.providersByID.get('compat-0')?.upstream_name).toBe('plugin-relay');
      expect(view.result.current.isProviderCatalogUnknown).toBe(true);
      await act(async () => { pending.release(); });
      await waitFor(() => expect(view.result.current.isProviderCatalogUnknown).toBe(false));
    } finally {
      view.unmount();
    }
  });

  it('falls back after a failed plugin image and recovers on a new source', () => {
    installOmcApi();
    const provider = { id: 'codex-0', family: 'codex', name: 'Relay', is_oauth: true };
    const view = (logo: string) => <ProviderMark provider={provider} sources={{ pluginLogos: { codex: logo } }} size={20} />;
    const { container, rerender } = renderWithOmc(view(SVG));
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex');
    rerender(view(PNG));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PNG);
  });

  it('uses the identity fallback for missing custom artwork and refreshes a replaced resource', async () => {
    const customID = '0123456789abcdef0123456789abcdef';
    const api = installOmcApi();
    api.on('GET', '/custom-icons', () => ({ icons: [{ id: customID, revision: 1 }] }));
    const { client, container } = renderWithOmc(<ProviderMark provider={{ id: 'codex-0', family: 'codex', name: 'Relay' }} sources={{ providerIcons: { 'codex-0': `custom:${customID}` } }} size={20} />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('revision=1'));
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex');
    await act(async () => { client.setQueryData(['custom-icons'], [{ id: customID, revision: 2 }]); });
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('revision=2'));
    await act(async () => { client.setQueryData(['custom-icons'], []); });
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex'));
  });

  it('never flashes a deployment custom icon while plugin ownership is pending or unavailable', async () => {
    const customID = '0123456789abcdef0123456789abcdef';
    const api = installOmcApi();
    const held = api.hold('GET', '/management/plugins');
    api.on('GET', '/custom-icons', () => ({ icons: [{ id: customID, revision: 1 }] }));
    const { client, container } = renderWithOmc(<ProviderMark provider={{ id: 'codex-0', family: 'codex' }} sources={{ providerIcons: { 'codex-0': `custom:${customID}` } }} size={20} />);
    await held.arrived;
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex');
    await act(async () => { held.release(json({ error: 'unavailable' }, 503)); });
    await waitFor(() => expect(client.getQueryState(['management-plugins'])?.status).toBe('error'));
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex');
    await act(async () => { client.setQueryData(['management-plugins'], { plugins: [{ id: 'codex', supports_oauth: true, enabled: false }] }); });
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/lobe-icons/codex');
  });
});
