import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ModelSquarePage } from '../src/pages/ModelSquarePage';
import type { ModelCatalogRefreshResult, ModelSquareDirectory } from '../src/types/modelSquare';
import { installOmcApi, json } from './support/omcApi';
import { renderWithOmc } from './support/render';

const directory: ModelSquareDirectory = { models: [], providers: [], routes: [], partial: [], model_info: {}, metadata_updated_at: '2026-10-01' };

const partialFailure: ModelCatalogRefreshResult = {
  ok: false,
  code: 'catalog_refresh_failed',
  changed_providers: ['codex'],
  catalogs: [
    { catalog: 'catalog', status: 'error', changed_providers: [], error_code: 'refresh_failed' },
    { catalog: 'codex-catalog', status: 'refreshed', changed_providers: ['codex'] },
    { catalog: 'devin-catalog', status: 'skipped', changed_providers: [] },
  ],
};

// Every catalog claims success, but the refresh as a whole does not.
const contradictory: ModelCatalogRefreshResult = {
  ok: false,
  code: 'catalog_refresh_failed',
  changed_providers: [],
  catalogs: partialFailure.catalogs.map(outcome => ({ catalog: outcome.catalog, status: 'refreshed', changed_providers: [] })),
};

const READINGS = ['/management/model-square', '/pricing', '/usage/facets'];

async function refreshCatalogs(reply: Response, { isRereadHeld = false } = {}) {
  const api = installOmcApi();
  api.on('GET', '/management/model-square', () => directory);
  api.on('GET', '/pricing', () => ({}));
  api.on('GET', '/usage/facets', () => ({}));
  api.on('POST', '/management/model-square/refresh-catalogs', () => reply);
  const surface = renderWithOmc(<ModelSquarePage />, { route: '/models' });
  // A model-rule drawer read earlier and since closed: nothing observes it, so only invalidation reaches it.
  const ruleCatalogKey = ['management-oauth-provider-models', 'codex'];
  surface.client.setQueryData(ruleCatalogKey, { available: true, models: [] });
  const button = await screen.findByRole('button', { name: 'Refresh catalogs' });
  await waitFor(() => expect(api.requests.filter(request => request.path === '/usage/facets')).toHaveLength(1));
  const heldReread = isRereadHeld ? api.hold('GET', '/usage/facets') : undefined;
  fireEvent.click(button);
  return { api, surface, ruleCatalogKey, button, heldReread };
}

async function expectReread({ api, surface, ruleCatalogKey }: Awaited<ReturnType<typeof refreshCatalogs>>) {
  // Each page reading is read once on mount and once after the refresh, the price book only by GET.
  await waitFor(() => expect(READINGS.map(path => api.requests.filter(request => request.method === 'GET' && request.path === path).length)).toEqual([2, 2, 2]));
  expect(surface.client.getQueryState(ruleCatalogKey)?.isInvalidated).toBe(true);
}

it('reports a partial catalog refresh as partial and re-reads what the catalogs feed', async () => {
  const refresh = await refreshCatalogs(json(partialFailure, 502), { isRereadHeld: true });
  // The refresh holds its button until the page has re-read, so a second click sends no second POST.
  await refresh.heldReread!.arrived;
  await waitFor(() => expect((screen.getByTestId('model-catalog-refresh') as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByTestId('model-catalog-refresh'));
  refresh.heldReread!.release();
  const title = await screen.findByText('Some model catalogs could not be refreshed');
  const notification = title.closest<HTMLElement>('.ant-notification-notice')!;
  expect(within(notification).getByText('CPA could not refresh this catalog')).toBeTruthy();
  expect(within(notification).getByText('Codex catalog')).toBeTruthy();
  const posts = refresh.api.requests.filter(request => request.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toBeUndefined();
  expect(posts[0].query.toString()).toBe('');
  await expectReread(refresh);
  await waitFor(() => expect((screen.getByTestId('model-catalog-refresh') as HTMLButtonElement).disabled).toBe(false));
});

it('re-reads after a gateway without catalog refresh and says so', async () => {
  const refresh = await refreshCatalogs(json({ code: 'catalog_refresh_unsupported', error: 'unsupported' }, 501));
  await screen.findByText('This gateway cannot refresh model catalogs');
  expect(screen.queryByText('Model catalogs refreshed')).toBeNull();
  await expectReread(refresh);
});

it('never reports success for a refresh the server did not call ok', async () => {
  const refresh = await refreshCatalogs(json(contradictory, 502));
  await screen.findByText('CPA did not confirm the catalog refresh');
  expect(screen.queryByText('Model catalogs refreshed')).toBeNull();
  await expectReread(refresh);
});

const unmappedErrorCode = {
  ...partialFailure,
  catalogs: partialFailure.catalogs.map(outcome => outcome.status === 'error' ? { ...outcome, error_code: 'upstream_exploded' } : outcome),
};

it.each([
  ['no report', { error: 'request failed' }],
  ['a report with an unmapped error code', unmappedErrorCode],
])('re-reads after a 502 carrying %s without reading it as a report, since CPA may have refreshed some catalogs', async (_label, body) => {
  const refresh = await refreshCatalogs(json(body, 502));
  await screen.findByText('Model catalogs could not be refreshed');
  expect(screen.queryByText('Some model catalogs could not be refreshed')).toBeNull();
  await expectReread(refresh);
});
