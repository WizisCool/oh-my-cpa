import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';

const VERTEX: ManagementAuthFile = { name: 'vertex-sa.json', auth_index: 'vertex-1', provider: 'vertex', type: 'vertex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0 };
const CODEX: ManagementAuthFile = { ...VERTEX, name: 'codex.json', auth_index: 'codex-1', provider: 'codex', type: 'codex' };

beforeEach(() => {
  window.localStorage.setItem('omc-lang', 'en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
});

function mount(file: ManagementAuthFile) {
  const writes: unknown[] = [];
  const onSaved = vi.fn();
  let fields: Record<string, unknown> = {
    name: file.name, disable_cooling: false, websockets: false, using_api: false,
    openapi: false, openapi_location: 'global', openapi_models: ['meta/a'], openapi_legacy_models: ['qwen/legacy'],
  };
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    let result: unknown;
    if (url.pathname.endsWith('/auth-files/safe-fields')) result = fields;
    else if (url.pathname.endsWith('/auth-files/fields')) {
      const body = JSON.parse(options.body as string);
      writes.push(body);
      fields = { ...fields, ...body };
      result = { status: 'ok', file, fields };
    } else throw new Error(`Unexpected request: ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const surface = render(<App><QueryClientProvider client={client}><I18nProvider>
    <AuthFileDetailDrawer open file={file} canEdit initialSection="overview" onClose={() => {}} onSaved={onSaved} onDownload={() => {}} />
  </I18nProvider></QueryClientProvider></App>);
  return { ...surface, client, writes, onSaved };
}

it('edits a Vertex service account\'s OpenAPI overrides and returns them to inheritance', async () => {
  const surface = mount(VERTEX);
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    const location = await screen.findByLabelText('OpenAPI location');
    await waitFor(() => expect((location as HTMLInputElement).value).toBe('global'));
    expect(screen.getByTestId('vertex-openapi-legacy-models').textContent).toContain('qwen/legacy');
    const section = screen.getByTestId('vertex-openapi-section');
    expect(section.querySelector('.ant-segmented-item-selected')?.textContent).toBe('Off');

    fireEvent.click(screen.getByText('Follow CPA'));
    fireEvent.change(location, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Registered models'), { target: { value: 'meta/a\nmeta/b' } });
    const save = screen.getByRole('button', { name: 'Save Fields' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.writes).toEqual([{
      name: VERTEX.name, auth_index: VERTEX.auth_index,
      openapi: null, openapi_location: null, openapi_models: ['meta/a', 'meta/b'],
    }]);
  } finally {
    surface.unmount(); surface.client.clear();
  }
});

it('does not offer the overrides for other credentials', async () => {
  const surface = mount(CODEX);
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    await screen.findByLabelText('Excluded Models');
    expect(screen.queryByTestId('vertex-openapi-section')).toBeNull();
  } finally {
    surface.unmount(); surface.client.clear();
  }
});
