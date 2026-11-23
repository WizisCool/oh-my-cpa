import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installOmcApi, json, type OmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';
import { usePreference } from '../src/hooks/usePreference';
import { useUsageEventViewState } from '../src/components/usage/useUsageEventViewState';
import { useRequestColumnLayout } from '../src/components/usage/useRequestColumnLayout';
import { RequestColumnsPopover } from '../src/components/usage/RequestColumnsPopover';
import { RequestStreamHeader } from '../src/components/usage/RequestStreamHeader';
import { RequestRow } from '../src/components/usage/RequestRow';
import { setReducedMotionPreference } from '../src/utils/motionPreference';
import { MOTION_ARRIVAL } from '../src/theme/themeConfig';
import type { UsageEvent } from '../src/types/usageEvents';
import { useOAuthManagementViewState } from '../src/pages/oauthManagement/useOAuthManagementViewState';
import { parseOAuthManagementView } from '../src/pages/oauthManagement/oauthWorkspaceLogic';

let api: OmcApi;
const writes = () => api.preferenceWrites();
const refuseWrites = () => api.on('PUT', /^\/preferences\//, () => json({ error: 'write_busy' }, 503));

function OAuthView() {
  const { queryState, setSearch, isViewLoaded } = useOAuthManagementViewState();
  return <>
    <output aria-label="view">{JSON.stringify(queryState)}</output>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ status: 'enabled', quota: 'attention', sort: 'priority-desc', page: null })}>Filter OAuth</button>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ page_size: 24, page: null })}>Resize OAuth</button>
    <button disabled={!isViewLoaded} onClick={() => setSearch({ q: null, status: null, quota: null, sort: null, page: null })}>Reset OAuth</button>
  </>;
}

function RequestView() {
  const view = useUsageEventViewState();
  return <>
    <output aria-label="view">{JSON.stringify({ grouping: view.grouping, query: view.query })}</output>
    <button disabled={!view.isEnabled} onClick={() => view.changeGrouping('source')}>Group requests</button>
    <button disabled={!view.isEnabled} onClick={() => view.commit({ auth_type: ['oauth'], latency_min: ['300'] })}>Filter requests</button>
  </>;
}

const mount = (children: React.ReactNode, route = '/') => renderWithOmc(children, { route, isStrict: true });

function readView() {
  return JSON.parse(screen.getByLabelText('view').textContent!);
}

beforeEach(() => {
  api = installOmcApi();
});

describe('list view preference persistence', () => {
  it('preserves old OAuth page sizes and normalizes unknown filter values', () => {
    expect(parseOAuthManagementView({ pageSize: 48, density: 'expanded' })).toEqual({ pageSize: 48, layout: 'list', status: 'all', quota: 'all', sort: 'custom' });
    expect(parseOAuthManagementView({ pageSize: '24', status: 'bogus', quota: 'bogus', sort: 'bogus', layout: 'bogus' })).toEqual({ pageSize: 12, layout: 'list', status: 'all', quota: 'all', sort: 'custom' });
    expect(parseOAuthManagementView({ layout: 'cards', sort: 'quota-asc' })).toMatchObject({ layout: 'cards', sort: 'quota-asc' });
  });

  it('saves OAuth filters and sorting with page size, restores them with a fresh cache and persists reset', async () => {
    const first = mount(<OAuthView />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Filter OAuth' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, layout: 'list', status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    first.unmount();
    const second = mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' }));
    expect(writes()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, layout: 'list', status: 'all', quota: 'all', sort: 'custom' });
    second.unmount();
    mount(<OAuthView />);
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'all', sort: 'custom' }));
  });

  it('honors explicit OAuth link dimensions without saving navigation or one-shot intent', async () => {
    api.state.preferences.oauth_management_view_v1 = { pageSize: 24, status: 'enabled', quota: 'attention', sort: 'priority-desc' };
    mount(<OAuthView />, '/?status=all&sort=name-desc&page=2&action=connect&connect_provider=codex');
    await waitFor(() => expect(readView()).toMatchObject({ pageSize: 24, status: 'all', quota: 'attention', sort: 'name-desc', page: 2, action: 'connect' }));
    expect(writes()).toHaveLength(0);
  });

  it('enables URL-only OAuth controls after a failed read without overwriting unread preferences', async () => {
    const unreadPreference = { pageSize: 48, status: 'disabled', quota: 'all', sort: 'name-desc' };
    api.state.preferences.oauth_management_view_v1 = unreadPreference;
    const read = api.hold('GET', '/preferences');
    mount(<OAuthView />);
    const filterButton = screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement;
    expect(filterButton.disabled).toBe(true);
    await act(async () => { read.release(json({ error: 'read_unavailable' }, 503)); });
    await waitFor(() => expect(filterButton.disabled).toBe(false));
    fireEvent.click(filterButton);
    expect(readView()).toMatchObject({ status: 'enabled', quota: 'attention', sort: 'priority-desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Resize OAuth' }));
    expect(readView().pageSize).toBe(24);
    fireEvent.click(screen.getByRole('button', { name: 'Reset OAuth' }));
    expect(readView()).toMatchObject({ status: 'all', quota: 'all', sort: 'custom', pageSize: 24 });
    expect(writes()).toHaveLength(0);
    expect(api.state.preferences.oauth_management_view_v1).toEqual(unreadPreference);
  });

  it('rolls OAuth controls back when a save fails instead of retaining an unsaved URL override', async () => {
    api.state.preferences.oauth_management_view_v1 = { pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' };
    mount(<OAuthView />, '/?sort=weight-desc');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Filter OAuth' }) as HTMLButtonElement).disabled).toBe(false));
    refuseWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Filter OAuth' }));
    await screen.findByText('write_busy');
    await waitFor(() => expect(readView()).toMatchObject({ status: 'disabled', quota: 'all', sort: 'weight-desc' }));
    expect(api.state.preferences.oauth_management_view_v1).toEqual({ pageSize: 24, status: 'disabled', quota: 'all', sort: 'name-desc' });
  });

  for (const route of ['/', '/?preset=24h&model=linked-model']) {
    it(`restores request grouping and advanced filters after remount from ${route}`, async () => {
      const first = mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Filter requests' }));
      await waitFor(() => expect(writes()).toHaveLength(2));
      first.unmount();
      mount(<RequestView />);
      await waitFor(() => expect(readView()).toMatchObject({ grouping: 'source', query: { filters: { auth_type: ['oauth'] }, ranges: { latency: { min: 300 } } } }));
      expect(writes()).toHaveLength(2);
    });

    it(`rolls request grouping back after refused saves from ${route}`, async () => {
      mount(<RequestView />, route);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Group requests' }) as HTMLButtonElement).disabled).toBe(false));
      await act(async () => { await Promise.resolve(); });
      refuseWrites();
      fireEvent.click(screen.getByRole('button', { name: 'Group requests' }));
      await screen.findByText('write_busy');
      await waitFor(() => expect(readView().grouping).toBe('time'));
      if (route !== '/') expect(readView().query).toMatchObject({ preset: '24h', filters: { model: ['linked-model'] } });
    });
  }
});

const SAMPLE_EVENT: UsageEvent = {
  id: 1,
  event_key: 'evt-1',
  request_id: 'req-001',
  timestamp_ms: 1_700_000_000_000,
  provider: 'openai',
  model: 'gpt-5',
  failed: false,
  generate: true,
  latency_ms: 1200,
  tokens: { input: 100, output: 50, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 150 },
  cost_usd: 0.01,
  has_request_log: false,
  api_key_alias: 'dev-key',
  client_agent: 'codex-cli',
};

const EMPTY_CREDENTIALS = new Map();

function RequestColumnsHarness() {
  const layout = useRequestColumnLayout(false);
  return (
    <div>
      {!layout.isStacked && (
        <RequestColumnsPopover
          orderedColumns={layout.orderedColumns}
          userHidden={layout.userHiddenSet}
          autoFolded={layout.autoFoldedColumns}
          visibleCount={layout.visibleCount}
          totalCount={layout.totalCount}
          isReady={layout.isReady}
          hasHiddenColumns={layout.hasHiddenColumns}
          hasCustomOrder={layout.hasCustomOrder}
          hasCustomWidths={layout.hasCustomWidths}
          onToggle={layout.handleToggleColumn}
          onShowAll={layout.handleShowAllColumns}
          onMove={layout.handleMoveColumn}
          onStep={layout.handleStepColumn}
          onResetOrder={layout.handleResetColumnOrder}
          onResetWidths={layout.handleResetAllWidths}
        />
      )}
      <section
        ref={layout.streamRef}
        data-testid="request-stream"
        data-hidden-columns={layout.hiddenColumnsAttr}
        data-seam-columns={layout.seamColumnsAttr}
        style={{ '--req-grid-columns': layout.gridTemplate } as React.CSSProperties}
      >
        <RequestStreamHeader
          columns={layout.orderedColumns}
          colWidths={layout.colWidths}
          handleResizeStart={layout.handleResizeStart}
          handleResetColumn={layout.handleResetColumn}
          handleResizeKeyDown={layout.handleResizeKeyDown}
          isSelecting={false}
          selectionState="none"
          onToggleAll={() => undefined}
        />
        <RequestRow
          event={SAMPLE_EVENT}
          credentials={EMPTY_CREDENTIALS}
          onOpen={() => undefined}
          onToggleSelect={() => undefined}
          columnOrder={layout.columnOrder}
        />
      </section>
    </div>
  );
}

const parseThemePref = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw : undefined);

function UnrelatedThemeWriter() {
  const { set } = usePreference('omc_theme', 'system', parseThemePref);
  return <button type="button" onClick={() => void set('dark')}>Set dark theme</button>;
}

describe('request column visibility and ordering preferences', () => {
  it('persists column visibility and order, aligns headers with rows, preserves custom widths, and separates resets', async () => {
    api.state.preferences.usage_events_columns = { provider: 240, client: 180 };
    const first = mount(<RequestColumnsHarness />);
    const trigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));

    // Open popover and hide Client + Key while preserving existing width overrides.
    fireEvent.click(trigger);
    const popover = await screen.findByTestId('request-columns-popover');
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Client' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Key' }));
    await waitFor(() => expect(writes()).toHaveLength(2));

    expect(api.state.preferences.usage_events_columns).toEqual({
      provider: 240,
      client: 180,
      hidden: ['key', 'client'],
    });
    expect(trigger.textContent).toContain('10/12');
    const stream = screen.getByTestId('request-stream');
    expect(stream.getAttribute('data-hidden-columns')).toBe('key client');

    // Keyboard reorder: move Result one step earlier (before Timestamp).
    const resultRow = popover.querySelector('[data-column-row="result"]') as HTMLElement;
    const resultHandle = within(resultRow).getByRole('button', { name: /Result/ });
    fireEvent.keyDown(resultHandle, { key: 'ArrowUp' });
    await waitFor(() => expect(writes()).toHaveLength(3));

    const headerLabels = [...stream.querySelectorAll('.req-th-label')].map((el) => el.textContent);
    expect(headerLabels.slice(0, 2)).toEqual(['Result', 'Timestamp']);
    const rowCols = [...stream.querySelectorAll('.request-row > .req-col')];
    expect(rowCols[0].className).toContain('req-col-result');
    expect(rowCols[0].textContent).toContain('Success');
    expect(rowCols[1].className).toContain('req-col-time');
    expect(rowCols[1].textContent).toContain('req-001');
    expect(stream.style.getPropertyValue('--req-grid-columns')).toMatch(/^0px 76px 96px /);

    // Remount with fresh query cache restores visibility, order, and preserved widths.
    first.unmount();
    mount(<RequestColumnsHarness />);
    const reopenedTrigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    await waitFor(() => expect(reopenedTrigger.disabled).toBe(false));
    await waitFor(() => expect(reopenedTrigger.textContent).toContain('10/12'));
    expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).toBe('key client');
    expect([...screen.getByTestId('request-stream').querySelectorAll('.req-th-label')].slice(0, 2).map((el) => el.textContent))
      .toEqual(['Result', 'Timestamp']);

    // Show all restores visibility without losing custom widths or custom order.
    fireEvent.click(reopenedTrigger);
    const reopenedPopover = await screen.findByTestId('request-columns-popover');
    fireEvent.click(within(reopenedPopover).getByTestId('request-columns-show-all'));
    await waitFor(() => expect(writes()).toHaveLength(4));
    expect(api.state.preferences.usage_events_columns).toMatchObject({ provider: 240, client: 180 });
    expect((api.state.preferences.usage_events_columns as Record<string, unknown>).hidden).toBeUndefined();
    expect(((api.state.preferences.usage_events_columns as { order?: string[] }).order ?? []).slice(0, 2)).toEqual(['result', 'time']);

    // Reset order restores canonical order while keeping custom widths.
    fireEvent.click(within(reopenedPopover).getByTestId('request-columns-reset-order'));
    await waitFor(() => expect(writes()).toHaveLength(5));
    expect(api.state.preferences.usage_events_columns).toEqual({ provider: 240, client: 180 });

    // Hide one column, then reset widths: hidden choice survives width reset.
    fireEvent.click(within(reopenedPopover).getByRole('checkbox', { name: 'Client' }));
    await waitFor(() => expect(writes()).toHaveLength(6));
    fireEvent.click(within(reopenedPopover).getByTestId('request-columns-reset-widths'));
    await waitFor(() => expect(writes()).toHaveLength(7));
    expect(api.state.preferences.usage_events_columns).toEqual({ hidden: ['client'] });
  });

  it('prevents hiding the last remaining visible column', async () => {
    api.state.preferences.usage_events_columns = {
      hidden: ['time', 'result', 'provider', 'mode', 'tps', 'latency', 'tokens', 'cost', 'cache', 'key', 'client'],
    };
    mount(<RequestColumnsHarness />);
    const trigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));
    fireEvent.click(trigger);
    const popover = await screen.findByTestId('request-columns-popover');
    const modelCheckbox = within(popover).getByRole('checkbox', { name: 'Model' });
    expect(modelCheckbox.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(modelCheckbox);
    expect(writes()).toHaveLength(0);
    expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).not.toContain('model');
  });

  it('composes user-hidden columns with auto-folding without mutating user preferences and hides control when stacked', async () => {
    const observers = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal('ResizeObserver', class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe(target: Element) { observers.set(target, this.cb); }
      unobserve(target: Element) { observers.delete(target); }
      disconnect() {
        for (const [target, cb] of observers) {
          if (cb === this.cb) observers.delete(target);
        }
      }
    });
    const emitWidth = async (width: number) => {
      const stream = screen.getByTestId('request-stream');
      const cb = observers.get(stream);
      await act(async () => {
        cb?.([{ target: stream, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      });
    };

    mount(<RequestColumnsHarness />);
    const trigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));

    // At 1140px, Client, Key, and Cache are auto-folded while still checked by the user.
    await emitWidth(1140);
    fireEvent.click(trigger);
    const popover = await screen.findByTestId('request-columns-popover');
    expect(within(popover).getByTestId('request-column-folded-client')).toBeTruthy();
    expect(within(popover).getByTestId('request-column-folded-key')).toBeTruthy();
    expect(within(popover).getByRole('checkbox', { name: 'Client' }).getAttribute('aria-checked')).toBe('true');

    // Hiding Tokens, Latency, and Cost frees enough width so Client, Key, and Cache unfold immediately.
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Tokens' }));
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Latency' }));
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Cost' }));
    await waitFor(() => expect(within(popover).queryByTestId('request-column-folded-client')).toBeNull());
    await waitFor(() => {
      expect(writes()).toHaveLength(3);
      expect(api.state.preferences.usage_events_columns).toEqual({ hidden: ['latency', 'tokens', 'cost'] });
    });

    // Entering stacked-card width hides the table-columns trigger without altering saved choices.
    await emitWidth(800);
    await waitFor(() => expect(screen.queryByTestId('request-columns-trigger')).toBeNull());
    await emitWidth(1500);
    const restoredTrigger = await screen.findByTestId('request-columns-trigger');
    expect(restoredTrigger.textContent).toContain('9/12');
    expect(writes()).toHaveLength(3);
    expect(api.state.preferences.usage_events_columns).toEqual({ hidden: ['latency', 'tokens', 'cost'] });
  });

  it('keeps local toggles usable after a failed read without writing and rolls back refused writes', async () => {
    const unread = { provider: 260, hidden: ['mode'] };
    api.state.preferences.usage_events_columns = unread;
    const read = api.hold('GET', '/preferences');
    const failedReadView = mount(<><RequestColumnsHarness /><UnrelatedThemeWriter /></>);
    const trigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    await act(async () => { read.release(json({ error: 'read_unavailable' }, 503)); });
    await waitFor(() => expect(trigger.disabled).toBe(false));
    fireEvent.click(trigger);
    const popover = await screen.findByTestId('request-columns-popover');
    fireEvent.click(within(popover).getByRole('checkbox', { name: 'Client' }));
    expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).toBe('client');
    expect(writes()).toHaveLength(0);

    // An unrelated optimistic preference write must not flip `loaded` true or discard session-local edits.
    fireEvent.click(screen.getByRole('button', { name: 'Set dark theme' }));
    await waitFor(() => expect(writes().filter((req) => req.key === 'omc_theme')).toHaveLength(1));
    expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).toBe('client');
    fireEvent.click(trigger);
    const reopenedPopover = await screen.findByTestId('request-columns-popover');
    fireEvent.click(within(reopenedPopover).getByRole('checkbox', { name: 'Key' }));
    expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).toBe('key client');
    expect(writes().filter((req) => req.key === 'usage_events_columns')).toHaveLength(0);
    expect(api.state.preferences.usage_events_columns).toEqual(unread);
    failedReadView.unmount();

    // Fresh mount with readable preferences + refused PUT rolls back UI cleanly.
    api.state.preferences.usage_events_columns = { provider: 260 };
    mount(<RequestColumnsHarness />);
    const liveTrigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
    await waitFor(() => expect(liveTrigger.disabled).toBe(false));
    refuseWrites();
    fireEvent.click(liveTrigger);
    const livePopover = await screen.findByTestId('request-columns-popover');
    fireEvent.click(within(livePopover).getByRole('checkbox', { name: 'Client' }));
    await screen.findByText('write_busy');
    await waitFor(() => expect(screen.getByTestId('request-stream').getAttribute('data-hidden-columns')).toBe(''));
    expect(within(livePopover).getByRole('checkbox', { name: 'Client' }).getAttribute('aria-checked')).toBe('true');
  });

  it('glides surviving columns and fades newly revealed columns in one move while honoring reduced motion', async () => {
    setReducedMotionPreference('off');
    try {
      mount(<RequestColumnsHarness />);
      const trigger = screen.getByTestId('request-columns-trigger') as HTMLButtonElement;
      await waitFor(() => expect(trigger.disabled).toBe(false));
      const stream = screen.getByTestId('request-stream');
      const header = stream.querySelector('.request-table-header') as HTMLElement;
      header.style.display = 'grid';

      const timeTh = stream.querySelector('.req-th-time') as HTMLElement;
      const resultTh = stream.querySelector('.req-th-result') as HTMLElement;
      const providerTh = stream.querySelector('.req-th-provider') as HTMLElement;
      const rect = (left: number, width: number) => ({
        left,
        right: left + width,
        top: 0,
        bottom: 32,
        width,
        height: 32,
        x: left,
        y: 0,
        toJSON: () => ({}),
      });
      const isTimeHidden = () => (stream.getAttribute('data-hidden-columns') ?? '').split(' ').includes('time');
      vi.spyOn(timeTh, 'getBoundingClientRect').mockImplementation(() => (isTimeHidden() ? rect(0, 0) : rect(20, 96)));
      vi.spyOn(resultTh, 'getBoundingClientRect').mockImplementation(() => (isTimeHidden() ? rect(20, 76) : rect(132, 76)));
      vi.spyOn(providerTh, 'getBoundingClientRect').mockImplementation(() => (isTimeHidden() ? rect(112, 210) : rect(224, 210)));

      const cancelSpy = vi.fn();
      const timeAnimate = vi.fn(() => ({ cancel: cancelSpy }) as unknown as Animation);
      const resultAnimate = vi.fn(() => ({ cancel: cancelSpy }) as unknown as Animation);
      const providerAnimate = vi.fn(() => ({ cancel: cancelSpy }) as unknown as Animation);
      timeTh.animate = timeAnimate;
      resultTh.animate = resultAnimate;
      providerTh.animate = providerAnimate;

      fireEvent.click(trigger);
      const popover = await screen.findByTestId('request-columns-popover');
      const timeCheckbox = within(popover).getByRole('checkbox', { name: 'Timestamp' });

      // Hiding Timestamp removes it immediately and glides Result & Provider left by 112px.
      fireEvent.click(timeCheckbox);
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(timeAnimate).not.toHaveBeenCalled();
      expect(resultAnimate).toHaveBeenCalledWith(
        [{ transform: 'translateX(112px)' }, { transform: 'translateX(0)' }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      );
      expect(providerAnimate).toHaveBeenCalledWith(
        [{ transform: 'translateX(112px)' }, { transform: 'translateX(0)' }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      );

      // Re-showing Timestamp cancels prior animations, fades Timestamp in, and glides others right.
      fireEvent.click(timeCheckbox);
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(cancelSpy).toHaveBeenCalled();
      expect(timeAnimate).toHaveBeenCalledWith(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      );
      expect(resultAnimate).toHaveBeenLastCalledWith(
        [{ transform: 'translateX(-112px)' }, { transform: 'translateX(0)' }],
        { duration: MOTION_ARRIVAL.duration, easing: MOTION_ARRIVAL.easing },
      );

      // Reduced motion suppresses all column glide and fade animations.
      timeAnimate.mockClear();
      resultAnimate.mockClear();
      providerAnimate.mockClear();
      setReducedMotionPreference('on');
      fireEvent.click(timeCheckbox);
      await waitFor(() => expect(writes()).toHaveLength(3));
      expect(timeAnimate).not.toHaveBeenCalled();
      expect(resultAnimate).not.toHaveBeenCalled();
      expect(providerAnimate).not.toHaveBeenCalled();
    } finally {
      setReducedMotionPreference('system');
    }
  });
});
