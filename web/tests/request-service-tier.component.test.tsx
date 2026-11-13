import { useState, type ReactNode } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RequestBackToTop,
  RequestCollapsibleHeader,
  RequestFoldToggle,
  RequestRestoreButton,
} from '../src/components/usage/RequestFoldControls';
import { RequestVirtualList } from '../src/components/usage/RequestVirtualList';
import { useRequestListScroll } from '../src/components/usage/useRequestListScroll';
import { setReducedMotionPreference } from '../src/utils/motionPreference';
import usageEventMessages from '../src/i18n/locales/en/usageEvents';
import { StructuredUsageView } from '../src/components/usage/StructuredUsageView';
import { UsageEventDrawer } from '../src/components/usage/UsageEventDrawer';
import { CostBreakdownView } from '../src/components/pricing/CostBreakdownView';
import type { RequestCostBreakdown } from '../src/types/pricing';
import { RequestRow } from '../src/components/usage/RequestRow';
import { TokenDisplayProvider } from '../src/types/tokenDisplayContext';
import type { UsageEvent } from '../src/types/usageEvents';
import { installOmcApi } from './support/omcApi';
import { createTestQueryClient, renderWithOmc } from './support/render';

function renderTier(overrides: Partial<UsageEvent>, renderContent?: (event: UsageEvent) => ReactNode) {
  const event: UsageEvent = {
    id: 274, event_key: 'codex-fast', timestamp_ms: 1_800_000_000_000,
    provider: 'codex', model: 'fixture-model', failed: false, generate: true,
    latency_ms: 1000, has_request_log: false,
    service_tier: 'priority', response_service_tier: 'default',
    tokens: { input: 100, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 110 },
    ...overrides,
  };
  const preferences = { omc_models_view: 'model', omc_request_model_icons: false };
  installOmcApi({ preferences: { ...preferences } });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: Infinity } });
  client.setQueryData(['usage-event', event.id], { event, related_errors: [] });
  client.setQueryData(['preferences'], preferences);
  return renderWithOmc(<TokenDisplayProvider>
    {renderContent ? renderContent(event) : <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />}
  </TokenDisplayProvider>, { client });
}

it('marks Codex priority and outbound/response Fast tiers accurately', () => {
  const first = renderTier({ resolved_service_tier: 'priority', resolved_service_tier_source: 'request' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/请求服务等级 priority|requested service tier priority/);
  first.unmount();

  const second = renderTier({ service_tier: 'auto', effective_service_tier: 'priority', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' });
  expect(screen.getByTestId('request-fast-tier').getAttribute('aria-label')).toMatch(/出站服务等级 priority|outbound service tier priority/);
  second.unmount();

  const third = renderTier({ provider: 'openai', resolved_service_tier: 'default', resolved_service_tier_source: 'response' });
  expect(screen.queryByTestId('request-fast-tier')).toBeNull();
  third.unmount();
});

it('shows the client, outbound and response tiers separately in request details and cost breakdown', async () => {
  const breakdown: RequestCostBreakdown = {
    status: 'priced', stored_nanos: 6_000_000, service_tier: 'priority', service_tier_source: 'outbound', recomputed_matches: true,
    price_version: { id: 1, available: true, effective_from_ms: 0, price: { model: 'fixture-model', upstream_id: '', channel: '', prompt_price_per_1m: 2, completion_price_per_1m: 10, cache_read_price_per_1m: 0, cache_write_price_per_1m: 0, price_multiplier: 1, source: 'manual', tiers: [{ service_tiers: ['priority'], prompt_price_per_1m: 4 }] } },
  };
  renderTier({ service_tier: 'auto', effective_service_tier: 'priority', response_service_tier: 'default', resolved_service_tier: 'priority', resolved_service_tier_source: 'outbound' }, event => <>
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
    <CostBreakdownView breakdown={breakdown} model="fixture-model" />
  </>);
  fireEvent.click(await screen.findByRole('tab', { name: /^(?:Raw fields|原始字段)$/ }));
  expect(await screen.findByText(/priority.*(?:based on outbound request|按出站判断)/)).toBeTruthy();
  expect(screen.getByText(/^(?:Outbound tier|出站档位)$/)).toBeTruthy();
  expect(screen.getByTestId('cost-service-tier').textContent).toMatch(/priced from outbound request|按出站档位计价/);
});

it('paints the duration from its ramp in the row and drawer, and leaves TTFT in the secondary ink', async () => {
  const { container } = renderTier({ latency_ms: 65_000, ttft_ms: 3_000 }, event => <>
    <RequestRow event={event} credentials={new Map()} onOpen={() => undefined} onToggleSelect={() => undefined} />
    <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />
  </>);
  // The row, the drawer's headline and its timing card read the same duration on the same ramp.
  const duration = await screen.findAllByText('65.00 s');
  expect(duration).toHaveLength(3);
  for (const readout of duration) {
    expect(readout.style.getPropertyValue('--duration-from')).toBe('var(--timing-green)');
    expect(readout.style.getPropertyValue('--duration-to')).toBe('var(--timing-orange)');
    expect(readout.style.getPropertyValue('--duration-from-share')).toBe('0%');
  }
  const ttft = container.querySelector('.req-ttft-val');
  expect(ttft?.textContent).toBe('TTFT 3.00 s');
  expect(ttft?.className).not.toContain('req-timing-value');
  const ramps = [...document.querySelectorAll<HTMLElement>('.req-timing-value')];
  expect(ramps).toHaveLength(3);
  // The first-token wait is drawn in its own secondary segment, never on the duration ramp.
  expect(screen.getByText(usageEventMessages['events.timing_wait']).closest('.req-timing-value')).toBeNull();
});

it('reads structured detail in the drawer without merging observations into canonical totals or estimated costs', async () => {
  renderTier({ cost_usd: 0.25, structured_usage: {
    tokens: { text_input_tokens: 0, image_input_tokens: 12 },
    cache_details: { by_ttl: { '5m': 0 } },
    tool_usage_details: { web_search_calls: 0, code_execution_calls: 2 },
    web_search_requests: 0,
    image_count: 0,
    requested_image_details: { size: '1024x1024', quality: 'high' },
    image_details: { size: '1536x1024' },
    media_counts: { audio_seconds: 0 },
    iterations: [{ output_tokens: 0, cache_creation: { by_ttl: { '1h': 5 } } }],
    cost_details: { cost: 0, upstream_inference_cost: 0.0000000000001, is_byok: false, cost_in_usd_ticks: 0 },
    is_partial: true,
  } }, event => <UsageEventDrawer eventId={event.id} credentials={new Map()} onClose={() => undefined} />);
  fireEvent.click(await screen.findByRole('tab', { name: /^Usage$/ }));
  const details = within(await screen.findByRole('region', { name: 'Upstream usage details' }));
  const valueFor = (label: string) => within(details.getByText(label).parentElement!).getByRole('definition').textContent;
  expect(valueFor('Text input tokens')).toBe('0');
  expect(valueFor('Web search calls')).toBe('0');
  expect(valueFor('Reported cost')).toBe('0');
});

it('keeps legacy structured usage unknown instead of fabricating zero-valued counters', () => {
  renderWithOmc(<StructuredUsageView />);
  expect(within(screen.getByRole('region', { name: 'Upstream usage details' })).getByText('Not captured')).toBeTruthy();
});

describe('request stream virtualization and desktop/mobile header fold', () => {
  const originalMatchMedia = window.matchMedia;
  const originalAnimate = Element.prototype.animate;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Element.prototype.animate = originalAnimate;
    setReducedMotionPreference('system');
  });

  function installTouchMatchMedia(isCoarse: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(any-pointer: coarse)' ? isCoarse : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  function StreamHarness({
    items,
    arrivedCount,
    onParentRender,
  }: {
    items: UsageEvent[];
    arrivedCount?: number;
    onParentRender?: () => void;
  }) {
    onParentRender?.();
    const scroll = useRequestListScroll({ viewScope: 'preset=1h', cursor: undefined });
    scroll.observeLatest(items);
    if (arrivedCount !== undefined) {
      scroll.noteFetchedBoundaryID(scroll.getHeldBoundaryID());
    }
    const displayed = scroll.resolveDisplayedItems(items);
    const pendingCount = scroll.pendingArrivals(arrivedCount);
    return (
      <div ref={scroll.pageRef} className="request-events-page">
        <RequestCollapsibleHeader collapse={scroll.collapse} pageRef={scroll.pageRef}>
          <div className="request-header-content">
            <input aria-label="Search requests" />
            <RequestFoldToggle collapse={scroll.collapse} onToggle={scroll.handleToggleExpand} />
          </div>
        </RequestCollapsibleHeader>
        <div className="request-stream-slot">
          <section className="request-stream">
            <div ref={scroll.scrollAreaRef} className="request-table-scroll-area">
              <RequestVirtualList
                ref={scroll.listRef}
                virtual
                overscanPx={144}
                items={displayed}
                getItemKey={(item) => item.id}
                onScroll={scroll.handleScroll}
                renderItem={(item) => <div data-testid="virtual-req-row">row-{item.id}</div>}
              />
            </div>
            <footer className="request-pagination">
              <RequestRestoreButton collapse={scroll.collapse} onRestore={scroll.handleToggleExpand} />
            </footer>
          </section>
          <RequestBackToTop scrolledDown={scroll.scrolledDown} pendingCount={pendingCount} onBackToTop={scroll.handleBackToTop} />
        </div>
      </div>
    );
  }

  function makeSyntheticEvents(count: number): UsageEvent[] {
    return Array.from({ length: count }, (_, index) => ({
      id: count - index,
      event_key: `evt-${index}`,
      timestamp_ms: 1_800_000_000_000 - index * 1_000,
      provider: 'openai',
      model: 'gpt-5',
      failed: false,
      generate: true,
      latency_ms: 420,
      has_request_log: false,
      tokens: { input: 10, output: 10, reasoning: 0, cached: 0, cache_read: 0, cache_creation: 0, total: 20 },
    }));
  }

  it('folds and restores on desktop wheel gestures without re-rendering parent on scroll thresholds, and respects reduced motion', () => {
    installTouchMatchMedia(false);
    let animateCalls = 0;
    Element.prototype.animate = vi.fn().mockImplementation(() => {
      animateCalls += 1;
      return {
        cancel: vi.fn(),
        finished: Promise.resolve(),
      } as unknown as Animation;
    });

    let parentRenders = 0;
    const events = makeSyntheticEvents(80);
    const { container } = renderWithOmc(
      <StreamHarness items={events} onParentRender={() => { parentRenders += 1; }} />,
    );

    const header = container.querySelector<HTMLElement>('.request-collapsible-header')!;
    const scrollArea = container.querySelector<HTMLElement>('.request-table-scroll-area')!;
    const list = container.querySelector<HTMLElement>('.request-list')!;
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 132 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5_760 });

    // Virtualization mounts only the overscanned window, not all 80 rows.
    const mountedInitial = screen.getAllByTestId('virtual-req-row');
    expect(mountedInitial.length).toBeLessThan(30);
    expect(mountedInitial[0].textContent).toBe('row-80');

    const rendersBeforeScroll = parentRenders;
    // Wheel-down at the top collapses the header via compositor WAAPI.
    act(() => {
      scrollArea.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    });
    expect(header.classList.contains('is-collapsed')).toBe(true);
    expect(animateCalls).toBeGreaterThan(0);

    // Scrolling past HOLD_FROM_PX (60px) updates only ViewFlag subscribers without re-rendering StreamHarness.
    list.scrollTop = 720;
    fireEvent.scroll(list);
    expect(parentRenders).toBe(rendersBeforeScroll);
    expect(container.querySelector('.req-back-to-top-btn')).not.toBeNull();
    expect(screen.getAllByTestId('virtual-req-row')[0].textContent).not.toBe('row-80');

    // Under reduced motion, wheel-up at the top restores immediately without calling Element.animate.
    setReducedMotionPreference('on');
    const callsBeforeReduced = animateCalls;
    list.scrollTop = 0;
    fireEvent.scroll(list);
    act(() => {
      scrollArea.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true, cancelable: true }));
    });
    expect(header.classList.contains('is-collapsed')).toBe(false);
    expect(animateCalls).toBe(callsBeforeReduced);
    // A trackpad flick drifts sideways and coasts into the top as a tail of small deltas; their sum
    // still restores the header.
    act(() => {
      scrollArea.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    });
    expect(header.classList.contains('is-collapsed')).toBe(true);
    act(() => {
      for (const deltaY of [-9, -8, -6, -5]) {
        scrollArea.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaX: 1.5, bubbles: true, cancelable: true }));
      }
    });
    expect(header.classList.contains('is-collapsed')).toBe(false);
  });

  it('auto-collapses on mobile downward touch scroll and restores on top pull-down or footer restore tap', () => {
    installTouchMatchMedia(true);
    const events = makeSyntheticEvents(60);
    const { container } = renderWithOmc(<StreamHarness items={events} />);

    const page = container.querySelector<HTMLElement>('.request-events-page')!;
    const header = container.querySelector<HTMLElement>('.request-collapsible-header')!;
    const scrollArea = container.querySelector<HTMLElement>('.request-table-scroll-area')!;
    const list = container.querySelector<HTMLElement>('.request-list')!;
    page.dataset.headerSpace = '220';
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 });
    // Overflow (200px) smaller than headerSpace (220px) + 140px must NOT auto-collapse or clamp scrollTop.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 });
    list.scrollTop = 64;
    fireEvent.scroll(list);
    expect(header.classList.contains('is-collapsed')).toBe(false);

    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 4_320 });
    const searchInput = screen.getByLabelText('Search requests');
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    // Downward touch scroll past 50px with ample overflow auto-collapses the header, marks it inert,
    // and rescues focus from any active header control onto the visible restore button.
    list.scrollTop = 96;
    fireEvent.scroll(list);
    expect(header.classList.contains('is-collapsed')).toBe(true);
    expect(header.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('.req-restore-header-btn'));

    // Returning to row 1 and pulling down >= 28px restores the header on touch screens.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    fireEvent.touchStart(scrollArea, {
      touches: [{ identifier: 1, clientX: 180, clientY: 220 }],
    });
    fireEvent.touchMove(scrollArea, {
      touches: [{ identifier: 1, clientX: 182, clientY: 256 }],
    });
    fireEvent.touchEnd(scrollArea, { touches: [] });
    expect(header.classList.contains('is-collapsed')).toBe(false);

    // Activating the focused expand button transfers keyboard focus to the footer restore button, and back on restore.
    const expandBtn = container.querySelector<HTMLElement>('[data-fold-control="expand"]')!;
    const restoreBtn = container.querySelector<HTMLElement>('.req-restore-header-btn')!;
    expandBtn.focus();
    expect(document.activeElement).toBe(expandBtn);
    fireEvent.click(expandBtn);
    expect(header.classList.contains('is-collapsed')).toBe(true);
    expect(restoreBtn.style.display).not.toBe('none');
    expect(document.activeElement).toBe(restoreBtn);
    fireEvent.click(restoreBtn);
    expect(header.classList.contains('is-collapsed')).toBe(false);
    expect(header.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(expandBtn);
  });

  it('compensates scrollTop when an overscanned row above the viewport measures taller than default', () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    installTouchMatchMedia(false);
    const events = makeSyntheticEvents(40);
    const { container } = renderWithOmc(<StreamHarness items={events} />);
    const list = container.querySelector<HTMLElement>('.request-list')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON: () => ({}),
    });

    list.scrollTop = 300;
    fireEvent.scroll(list);

    const rows = container.querySelectorAll<HTMLElement>('.request-list-item-virtual');
    const aboveRow = rows[0]!;
    vi.spyOn(aboveRow, 'getBoundingClientRect').mockReturnValue({
      top: -10, bottom: 90, left: 0, right: 800, width: 800, height: 100, x: 0, y: -10, toJSON: () => ({}),
    });

    act(() => {
      for (const callback of callbacks) {
        callback(
          [{ target: aboveRow, contentRect: { width: 800, height: 100 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    });

    // Default row height is 72px; measuring 100px above viewportTop (100) adds +28px to scrollTop.
    expect(list.scrollTop).toBe(328);
  });

  it('holds scrolled rows steady when live updates arrive and reveals them on back-to-top', () => {
    installTouchMatchMedia(false);
    const initial = makeSyntheticEvents(40);
    let pushItems: ((next: UsageEvent[], arrived: number) => void) | undefined;
    function LiveHarness() {
      const [state, setState] = useState<{ items: UsageEvent[]; arrivedCount?: number }>({
        items: initial,
      });
      pushItems = (next, arrived) => setState({ items: next, arrivedCount: arrived });
      return <StreamHarness items={state.items} arrivedCount={state.arrivedCount} />;
    }
    const { container } = renderWithOmc(<LiveHarness />);
    const list = container.querySelector<HTMLElement>('.request-list')!;

    list.scrollTop = 240;
    fireEvent.scroll(list);
    const snapshotBeforeArrival = screen.getAllByTestId('virtual-req-row').map((el) => el.textContent);

    const newer: UsageEvent[] = [
      { ...initial[0], id: 42, event_key: 'evt-new-2' },
      { ...initial[0], id: 41, event_key: 'evt-new-1' },
      ...initial,
    ];
    act(() => {
      pushItems!(newer, 2);
    });

    // Held rows and scroll offset remain frozen while reading down the list.
    expect(list.scrollTop).toBe(240);
    expect(screen.getAllByTestId('virtual-req-row').map((el) => el.textContent)).toEqual(snapshotBeforeArrival);
    expect(screen.queryByText('row-42')).toBeNull();
    const backBtn = container.querySelector<HTMLButtonElement>('.req-back-to-top-btn.is-live');
    expect(backBtn).not.toBeNull();
    expect(backBtn?.textContent).toContain('2 new records');

    fireEvent.click(backBtn!);
    expect(screen.getAllByTestId('virtual-req-row')[0].textContent).toBe('row-42');
  });

  it('numbers rows by their place within the group, so interleaved groups still alternate', () => {
    const items = [
      { id: 'a1', group: 'A' },
      { id: 'b1', group: 'B' },
      { id: 'a2', group: 'A' },
      { id: 'a3', group: 'A' },
    ];
    renderWithOmc(
      <RequestVirtualList
        virtual={false}
        items={items}
        getItemKey={(item) => item.id}
        group={{ key: (item) => item.group, title: (key) => key }}
        renderItem={(item, position) => <div data-testid="grouped-row">{`${item.id}:${position}`}</div>}
      />,
    );
    expect(screen.getAllByTestId('grouped-row').map((row) => row.textContent)).toEqual(['a1:0', 'a2:1', 'a3:2', 'b1:0']);
  });
});
