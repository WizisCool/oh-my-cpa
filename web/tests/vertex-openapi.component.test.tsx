import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthFileDetailDrawer } from '../src/components/authFiles/AuthFileDetailDrawer';
import type { ManagementAuthFile } from '../src/types/managementAuthFile';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const VERTEX: ManagementAuthFile = { name: 'vertex-sa.json', auth_index: 'vertex-1', provider: 'vertex', type: 'vertex', disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0 };
const CODEX: ManagementAuthFile = { ...VERTEX, name: 'codex.json', auth_index: 'codex-1', provider: 'codex', type: 'codex' };

function mount(file: ManagementAuthFile) {
  const onSaved = vi.fn();
  const api = installOmcApi({ authFiles: [{ file, fields: {
    disable_cooling: false, websockets: false, using_api: false,
    openapi: false, openapi_location: 'global', openapi_models: ['meta/a'], openapi_legacy_models: ['qwen/legacy'],
  } }] });
  const surface = renderWithOmc(<AuthFileDetailDrawer open file={file} canEdit initialSection="overview" onClose={() => {}} onSaved={onSaved} onDownload={() => {}} />);
  return { ...surface, onSaved, get writes() { return api.writes('/management/auth-files/fields').map(request => request.body); } };
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
    const save = screen.getByRole('button', { name: 'Save fields' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(surface.onSaved).toHaveBeenCalledOnce());
    expect(surface.writes).toEqual([{
      name: VERTEX.name, auth_index: VERTEX.auth_index,
      openapi: null, openapi_location: null, openapi_models: ['meta/a', 'meta/b'],
    }]);
  } finally {
    surface.unmount();
  }
});

it('does not offer the overrides for other credentials', async () => {
  const surface = mount(CODEX);
  try {
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    await screen.findByLabelText('Excluded models');
    expect(screen.queryByTestId('vertex-openapi-section')).toBeNull();
  } finally {
    surface.unmount();
  }
});
