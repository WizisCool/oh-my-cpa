import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router-dom';
import { DeferredMount } from '../src/components/common/DeferredMount';
import { AuthGate } from '../src/components/common/AuthGate';
import { RouteErrorPage } from '../src/components/common/RouteErrorPage';
import * as chunkRecovery from '../src/utils/chunkRecovery';
import { api, ApiError } from '../src/api/client';
import { clearReloadRecoveryState, readAuthShellHint, writeAuthShellHint } from '../src/utils/reloadRecovery';
import { Tooltip } from '../src/components/common/Tooltip';
import { progressTasks } from '../src/utils/progressTasks';
import { AppDrawer } from '../src/components/common/AppDrawer';
import { AppModal } from '../src/components/common/AppModal';
import { ConfirmAction } from '../src/components/common/ConfirmAction';
import { confirmModal } from '../src/components/feedback';
import { EmptyState } from '../src/components/common/EmptyState';
import { Meter } from '../src/components/common/Meter';
import { NumberInput } from '../src/components/common/NumberInput';
import { Pager } from '../src/components/common/Pager';
import { SearchInput } from '../src/components/common/SearchInput';
import { SectionHeading } from '../src/components/common/SectionHeading';
import { SelectionBar } from '../src/components/common/SelectionBar';
import { EffortTag, Tag, ToggleTag } from '../src/components/common/Tag';
import { PageHeader } from '../src/components/common/PageHeader';
import { SummaryStrip } from '../src/components/common/SummaryStrip';
import { MaskedText } from '../src/components/common/MaskedText';
import { MarkArtwork } from '../src/components/common/MarkArtwork';
import { RemoteImage } from '../src/components/common/RemoteImage';
import { Select } from '../src/components/ui/select';
import { Tabs } from '../src/components/ui/tabs';
import { Combobox } from '../src/components/ui/combobox';
import { AutoComplete } from '../src/components/ui/autocomplete';
import { DataTable } from '../src/components/ui/table';
import { I18nProvider, useI18n, useT, type MessageKey } from '../src/i18n';
import { ThemeProvider } from '../src/theme/ThemeContext';
import { DashboardTrendChart } from '../src/charts/DashboardTrendChart';
import { formatCacheRate } from '../src/theme/cacheScale';
import { RoutingPanel } from '../src/components/dashboard/routing/RoutingPanel';
import { LoadingRegion, Placeholder } from '../src/components/common/Placeholder';
import { PAGE_SKELETON_REGISTRY, RouteSkeleton, type RouteLoadingBody } from '../src/components/common/PageLoading';
import { ShellLoading } from '../src/components/common/ShellLoading';
import { ThreadPlaceholder } from '../src/components/workspace/ThreadPlaceholder';
import { createTestQueryClient, renderWithOmc } from './support/render';
import { installOmcApi, json } from './support/omcApi';

describe('SearchInput', () => {
  it('is named by its label, shows it as the placeholder, and reports text rather than events', () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} label="Search keys" />);
    const field = screen.getByRole('textbox', { name: 'Search keys' });
    expect(field.getAttribute('placeholder')).toBe('Search keys');

    fireEvent.change(field, { target: { value: 'prod' } });

    expect(onChange.mock.calls).toEqual([['prod']]);
  });

  it('keeps a longer placeholder apart from the accessible name and clears to an empty string', () => {
    const onChange = vi.fn();
    render(
      <SearchInput value="prod" onChange={onChange} label="Search requests" placeholder="Model, key or request ID" />,
    );
    expect(screen.getByRole('textbox', { name: 'Search requests' }).getAttribute('placeholder')).toBe('Model, key or request ID');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange.mock.calls).toEqual([['']]);
  });
});

describe('EmptyState', () => {
  it('draws the mark for a block and omits it inside a panel', () => {
    const { container, rerender } = render(<EmptyState title="No plugins installed" />);
    expect(container.querySelector('.empty-state.is-block .empty-state-mark')).not.toBeNull();

    rerender(<EmptyState size="compact" title="No plugins installed" />);

    expect(container.querySelector('.empty-state.is-compact')).not.toBeNull();
    expect(container.querySelector('.empty-state-mark')).toBeNull();
  });

  it('renders the second line and the action only when given', () => {
    const { container, rerender } = render(<EmptyState title="No requests" />);
    expect(container.querySelector('.empty-state-description')).toBeNull();
    expect(container.querySelector('.empty-state-action')).toBeNull();

    rerender(<EmptyState title="No requests" description="Nothing matches these filters."><button type="button">Clear filters</button></EmptyState>);

    expect(screen.getByText('Nothing matches these filters.')).toBeTruthy();
    expect(container.querySelector('.empty-state-action button')?.textContent).toBe('Clear filters');
  });
});

describe('SectionHeading', () => {
  it('uses the element the outline asks for and carries the count inside the title', () => {
    render(<SectionHeading as="h2" level="section" title="Models" count={12} id="models-heading" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.id).toBe('models-heading');
    expect(heading.textContent).toBe('Models12');
    expect(heading.closest('.section-head')?.classList.contains('is-section')).toBe(true);
  });

  it('gives a label no description and renders an absent extra as nothing', () => {
    const { container, rerender } = render(
      <SectionHeading level="label" title="Details" description="Ignored at this weight" extra={false} />,
    );
    expect(container.querySelector('.section-head-description')).toBeNull();
    expect(container.querySelector('.section-head-extra')).toBeNull();

    rerender(<SectionHeading title="Sources" description="Where plugins install from" descriptionId="sources-desc" extra={<button type="button">Add</button>} />);

    expect(container.querySelector('#sources-desc')?.textContent).toBe('Where plugins install from');
    expect(container.querySelector('.section-head-extra button')?.textContent).toBe('Add');
  });
});

describe('AppDrawer', () => {
  beforeEach(() => { window.localStorage.setItem('omc-lang', 'en'); });

  it('names its close control and lays the footer out as two slots', () => {
    installOmcApi();
    const onClose = vi.fn();
    renderWithOmc(
      <AppDrawer open widthKey="price" title="Edit price" onClose={onClose} footerStart="Applies to new requests" footer={<button type="button">Save</button>}>
        body
      </AppDrawer>,
    );
    expect(document.querySelector('.app-drawer-footer-start')?.textContent).toBe('Applies to new requests');
    expect(document.querySelector('.app-drawer-footer-actions button')?.textContent).toBe('Save');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps showing what it showed while open as it closes, though the caller has cleared it', () => {
    installOmcApi();
    let select!: (record: string | null) => void;
    const Host = () => {
      const [record, setRecord] = React.useState<string | null>('request 42');
      select = setRecord;
      return (
        <AppDrawer open={record !== null} widthKey="record" title={record} footer={record && <button type="button">Copy {record}</button>}>
          {record && <p>Body of {record}</p>}
        </AppDrawer>
      );
    };
    renderWithOmc(<Host />);

    act(() => select(null));

    expect(screen.getByText('Body of request 42')).toBeTruthy();
    expect(document.querySelector('[data-slot="sheet-title"]')?.textContent).toBe('request 42');
    expect(document.querySelector('.app-drawer-footer-actions button')?.textContent).toBe('Copy request 42');
  });

  it('remembers a dragged width per panel within the window\'s bounds, and forgets it on a click', async () => {
    // jsdom's window is 1024px wide: a medium panel may grow until 248px of the page is left.
    const omc = installOmcApi({ preferences: { omc_drawer_widths: { audit: 700 } } });
    renderWithOmc(<AppDrawer open widthKey="price" title="Edit price">body</AppDrawer>);
    const edge = await screen.findByRole('separator', { name: 'Resize panel' });
    expect(edge.getAttribute('aria-valuemax')).toBe('776');
    expect(edge.getAttribute('aria-valuemin')).toBe('360');

    fireEvent.keyDown(edge, { key: 'Home' });
    await waitFor(() => expect(omc.preferenceWrites()).toEqual([
      { key: 'omc_drawer_widths', value: { audit: 700, price: 776 } },
    ]));
    expect(edge.getAttribute('aria-valuetext')).toBe('Panel width 776 pixels');

    // Enter is the keyboard's click on the edge.
    fireEvent.keyDown(edge, { key: 'Enter' });
    await waitFor(() => expect(omc.preferenceWrites().at(-1)).toEqual({ key: 'omc_drawer_widths', value: { audit: 700 } }));
  });
});

describe('Tag', () => {
  it('hides its decorative glyph from assistive technology', () => {
    const { container } = render(<Tag icon={<svg />}>Unsaved</Tag>);
    expect(container.querySelector('svg')?.parentElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('as a toggle reports the opposite of its pressed state', () => {
    const onChange = vi.fn();
    render(<ToggleTag checked={false} onChange={onChange}>Providers (12)</ToggleTag>);
    const toggle = screen.getByRole('button', { name: 'Providers (12)' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it('as an effort spells the parameter and colours only a ranked level that reasons', () => {
    for (const [effort, label, hue] of [['max', 'Max', 'var(--effort-6)'], ['xhigh', 'xHigh', 'var(--effort-5)'], ['high', 'High', 'var(--effort-4)'], ['low', 'Low', 'var(--effort-2)'], ['none', 'None', ''], ['ultra', 'Ultra', '']]) {
      const { container, unmount } = render(<EffortTag effort={effort} />);
      const tag = container.querySelector<HTMLElement>('.effort-tag')!;
      expect(tag.textContent, effort).toBe(label);
      expect(tag.classList.contains('is-small'), effort).toBe(true);
      expect(tag.style.getPropertyValue('--effort-hue'), effort).toBe(hue);
      unmount();
    }
    expect(render(<EffortTag effort="" />).container.innerHTML).toBe('');
  });
});

describe('ConfirmAction', () => {
  it('fixes the cancel label, names the confirming button and colours a destructive one', () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider>
        <ConfirmAction open title="Delete this key?" confirmLabel="Delete" isDanger onConfirm={onConfirm}>
          <button type="button">Remove</button>
        </ConfirmAction>
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm.hasAttribute('data-danger')).toBe(true);

    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("puts the trigger's tooltip away while the confirmation is open", async () => {
    render(
      <I18nProvider>
        <ConfirmAction title="Delete this key?" confirmLabel="Delete" tooltip="Delete key">
          <button type="button">Remove</button>
        </ConfirmAction>
      </I18nProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Remove' });
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Delete key'));

    fireEvent.click(trigger);

    await screen.findByRole('button', { name: 'Cancel' });
    // jsdom never ends a motion, so a tooltip on its way out keeps its node in the leave state.
    await waitFor(() => {
      const tooltip = screen.queryByRole('tooltip');
      expect(!tooltip || tooltip.hasAttribute('data-ending-style')).toBe(true);
    });
  });
});

describe('SelectionBar', () => {
  it('announces the count, keeps the note beside it and the actions at the trailing edge', () => {
    const { container } = render(
      <SelectionBar label="Selection" summary="3 selected" note="2 on other pages">
        <button type="button">Delete</button>
      </SelectionBar>,
    );
    expect(screen.getByRole('status').textContent).toBe('3 selected');
    expect(container.querySelector('.selection-bar')).toBeTruthy();
    expect(container.querySelector('.selection-bar-note')?.textContent).toBe('2 on other pages');
    expect(container.querySelector('.selection-bar-actions button')?.textContent).toBe('Delete');
  });
});

describe('NumberInput', () => {
  /** Dispatches one notch over the field; a prevented wheel is one the field took for itself. */
  const wheelOver = (input: HTMLElement, deltaY: number) =>
    input.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));

  it('steps the field only once the caret is in it, so a wheel crossing it still scrolls', () => {
    const onChange = vi.fn();
    render(<NumberInput value={2} onChange={onChange} />);
    const input = screen.getByRole('spinbutton');

    // A wheel that only crosses the field belongs to the page: the value holds, the caret stays out,
    // and the event is left uncancelled so the scroll it was meant for still happens.
    expect(wheelOver(input, -100)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);

    act(() => input.focus());

    // Holding the caret, the field takes the notch as its own step.
    expect(wheelOver(input, -100)).toBe(false);
    expect(onChange.mock.calls).toEqual([[3]]);
  });

  it('leaves the wheel to the page when it is disabled', () => {
    const onChange = vi.fn();
    render(<NumberInput value={2} onChange={onChange} disabled />);
    const input = screen.getByRole('spinbutton');

    expect(wheelOver(input, -100)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Meter', () => {
  it('draws the share, clamps a reading outside the range and names itself only when labelled', () => {
    const { container, rerender } = render(<Meter value={3} max={12} label="3 of 12 excluded" />);
    const meter = screen.getByRole('meter', { name: '3 of 12 excluded' });
    expect(meter.getAttribute('aria-valuenow')).toBe('3');
    expect((container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('25%');

    rerender(<Meter value={140} color="var(--danger)" size="thick" />);

    const hidden = container.querySelector('.meter.is-thick') as HTMLElement;
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
    expect(hidden.getAttribute('role')).toBeNull();
    expect((container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('100%');
  });

  it('draws an empty track for a range with nothing in it', () => {
    const { container } = render(<Meter value={0} max={0} label="0 of 0" />);
    expect((container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('0%');
  });
});

describe('Pager', () => {

  it('renders nothing when the list fits on one page', () => {
    const { container } = render(<Pager page={1} pageSize={20} total={20} onChange={() => undefined} />);
    expect(container.querySelector('.pager')).toBeNull();
  });

  it('reports the page chosen and offers no page-size menu', () => {
    const onChange = vi.fn();
    const { container } = render(<Pager page={1} pageSize={20} total={48} onChange={onChange} />);
    expect(container.querySelector('select')).toBeNull();

    fireEvent.click(container.querySelector('[data-page="2"]') as HTMLElement);

    expect(onChange).toHaveBeenCalledWith(2, 20);
  });

  it('steps through pages without a field to type in', () => {
    const { container } = render(<Pager variant="stepped" page={2} pageSize={10} total={48} onChange={() => undefined} />);
    expect(container.querySelector('[data-variant="stepped"]')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });
});

describe('the translator', () => {
  function UnknownIds() {
    const t = useT();
    // A miss reaches the translator as plain text: the runtime answers any string with itself, and
    // this is the one place a caller has to say so.
    return <span>{t('toString' as MessageKey)} / {t('no.such.id' as MessageKey, { n: 1 })}</span>;
  }

  it('renders an id the catalog does not define as itself, including a name the prototype carries', () => {
    render(<I18nProvider><UnknownIds /></I18nProvider>);
    expect(document.body.textContent).toContain('toString / no.such.id');
  });
});


describe('Tooltip', () => {
  it('evaluates a reading only on intent and keeps the focused trigger and its draft through the popup lifecycle', async () => {
    const reading = vi.fn(() => 'Current reading');
    const { rerender } = render(<Tooltip title={reading} open={false}><input aria-label="Draft" defaultValue="initial" aria-describedby="field-hint" /></Tooltip>);
    const trigger = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.change(trigger, { target: { value: 'unfinished draft' } });
    trigger.focus();
    expect(reading).not.toHaveBeenCalled();

    rerender(<Tooltip title={reading} open><input aria-label="Draft" defaultValue="initial" aria-describedby="field-hint" /></Tooltip>);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Current reading'));
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-describedby')?.split(' ')).toContain('field-hint');
    expect((trigger as HTMLInputElement).value).toBe('unfinished draft');

    rerender(<Tooltip title={reading} open={false}><input aria-label="Draft" defaultValue="initial" aria-describedby="field-hint" /></Tooltip>);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-describedby')).toBe('field-hint');
  });

  it('opens a tap-readable or delegated data-tip on mobile touch and reliably closes on outside tap, repeat tap, or scroll', async () => {
    const { ChartContainer, ChartTooltipContent } = await import('../src/components/ui/chart');
    const { DelegatedTooltipLayer } = await import('../src/components/ui/tooltip');

    render(
      <div>
        <DelegatedTooltipLayer />
        <span data-testid="tip-badge" data-tip="Exact: 1,234,567 tokens">1.2M</span>
        <div data-testid="outside">Outside area</div>
        <ChartContainer config={{ val: { label: 'Tokens', color: '#00a2fb' } }} responsive={false} data-testid="mobile-chart">
          <ChartTooltipContent active label="12:00" payload={[{ name: 'val', dataKey: 'val', value: 4200, payload: { t: 1 } }]} />
        </ChartContainer>
      </div>,
    );

    const badge = screen.getByTestId('tip-badge');
    const outside = screen.getByTestId('outside');
    const chart = screen.getByTestId('mobile-chart');

    // 1. Mobile tap on non-interactive data-tip opens it, outside tap closes it immediately.
    fireEvent.pointerDown(badge, { pointerType: 'touch', clientX: 20, clientY: 20 });
    fireEvent.pointerUp(badge, { pointerType: 'touch', clientX: 20, clientY: 20 });
    await waitFor(() => expect(screen.getByText('Exact: 1,234,567 tokens')).toBeTruthy());

    fireEvent.pointerDown(outside, { pointerType: 'touch', clientX: 200, clientY: 200 });
    await waitFor(() => expect(screen.queryByText('Exact: 1,234,567 tokens')).toBeNull());

    // 2. ChartTooltipContent on mobile touch: visible on tap, closes on outside tap and on scroll.
    fireEvent.pointerDown(chart, { pointerType: 'touch', clientX: 50, clientY: 50 });
    fireEvent.pointerUp(chart, { pointerType: 'touch', clientX: 50, clientY: 50 });
    expect(chart.querySelector('[data-slot="chart-tooltip"]')).not.toBeNull();

    // Repeat tap on same active point toggles chart tooltip off!
    fireEvent.pointerDown(chart, { pointerType: 'touch', clientX: 50, clientY: 50 });
    fireEvent.pointerUp(chart, { pointerType: 'touch', clientX: 50, clientY: 50 });
    expect(chart.querySelector('[data-slot="chart-tooltip"]')).toBeNull();

    // Tap again to open, then scroll page -> closes immediately!
    fireEvent.pointerDown(chart, { pointerType: 'touch', clientX: 60, clientY: 50 });
    fireEvent.pointerUp(chart, { pointerType: 'touch', clientX: 60, clientY: 50 });
    expect(chart.querySelector('[data-slot="chart-tooltip"]')).not.toBeNull();

    fireEvent.scroll(document);
    expect(chart.querySelector('[data-slot="chart-tooltip"]')).toBeNull();
  });
});

describe('Delegated tooltip cards', () => {
  it('draws a card as rows, keeps an echo silent, and closes the open hint when the pointer reaches it', async () => {
    const { DelegatedTooltipLayer } = await import('../src/components/ui/tooltip');
    const { tipCard } = await import('../src/components/common/tipCard');
    render(
      <div>
        <DelegatedTooltipLayer />
        <span data-testid="card" {...tipCard({ heading: 'Versus the previous period', rows: [{ label: 'Change', value: '+40.2%', tone: 'up' }], notes: ['Scaled from the robust average'] })}>40.2%</span>
        <span data-testid="echo" data-tip="1,234">1,234</span>
      </div>,
    );
    const card = screen.getByTestId('card');
    fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerUp(card, { pointerType: 'touch', clientX: 10, clientY: 10 });
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-readout"]')).not.toBeNull());
    const popup = document.querySelector('[data-slot="tooltip"]')!;
    expect(popup.textContent).toContain('Change');
    expect(popup.textContent).toContain('+40.2%');
    expect(popup.textContent).toContain('Scaled from the robust average');

    // The exact count equals what the element already prints, so the tap closes the card and opens nothing.
    const echo = screen.getByTestId('echo');
    fireEvent.pointerDown(echo, { pointerType: 'touch', clientX: 40, clientY: 10 });
    fireEvent.pointerUp(echo, { pointerType: 'touch', clientX: 40, clientY: 10 });
    await waitFor(() => expect(screen.queryByText('Scaled from the robust average')).toBeNull());
    expect(screen.queryByText('1,234', { selector: '[data-slot="tooltip"] *, [data-slot="tooltip"]' })).toBeNull();
  });
});

describe('DeferredMount', () => {
  it('counts an optional editor download on first use and keeps its draft while it closes and reopens', async () => {
    const initialize = vi.fn();
    function Editor({ isOpen }: { isOpen: boolean }) {
      React.useEffect(() => { initialize(); }, []);
      return <input aria-label="Optional draft" hidden={!isOpen} defaultValue="initial" />;
    }
    let finishDownload!: (module: { default: typeof Editor }) => void;
    const LazyEditor = React.lazy(() => new Promise<{ default: typeof Editor }>((resolve) => { finishDownload = resolve; }));
    const view = (isOpen: boolean) => <DeferredMount isActive={isOpen}><LazyEditor isOpen={isOpen} /></DeferredMount>;
    const { rerender } = render(view(false));
    expect(initialize).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Optional draft')).toBeNull();
    rerender(view(true));
    expect(progressTasks.read().size).toBe(1);
    await act(async () => { finishDownload({ default: Editor }); });
    expect(progressTasks.read().size).toBe(0);
    const field = screen.getByLabelText('Optional draft');
    fireEvent.change(field, { target: { value: 'unfinished draft' } });
    rerender(view(false));
    rerender(view(true));
    expect(screen.getByLabelText('Optional draft')).toBe(field);
    expect((field as HTMLInputElement).value).toBe('unfinished draft');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('contains a rejected optional download without replacing the page or losing its draft', async () => {
    let rejectDownload!: (error: Error) => void;
    const LazyEditor = React.lazy(() => new Promise<{ default: React.ComponentType }>((_resolve, reject) => {
      rejectDownload = reject;
    }));
    function Page() {
      const [isActive, setIsActive] = React.useState(false);
      return <>
        <input aria-label="Page draft" defaultValue="initial" />
        <button type="button" onClick={() => setIsActive((current) => !current)}>Toggle editor</button>
        <DeferredMount isActive={isActive}><LazyEditor /></DeferredMount>
      </>;
    }
    const router = createMemoryRouter([{
      path: '/',
      element: <Page />,
      errorElement: <p role="alert">Route unavailable</p>,
    }]);
    renderWithOmc(<RouterProvider router={router} />);
    const draft = screen.getByRole('textbox', { name: 'Page draft' });
    fireEvent.change(draft, { target: { value: 'unfinished page draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor' }));
    expect(progressTasks.read().size).toBe(1);

    await act(async () => { rejectDownload(new TypeError('Failed to fetch dynamically imported module: editor.js')); });

    expect(screen.getByRole('textbox', { name: 'Page draft' })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('unfinished page draft');
    expect(progressTasks.read().size).toBe(0);
    expect(await screen.findByTestId('optional-surface-failure')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Page draft' })).toBe(draft);
  });

  it('leaves non-download failures to the route diagnostic boundary', async () => {
    const BrokenEditor: React.FC = () => {
      throw new Error('Editor render failed');
    };
    const LazyEditor = React.lazy(async () => ({ default: BrokenEditor }));
    function Page() {
      const [isActive, setIsActive] = React.useState(false);
      return <>
        <button type="button" onClick={() => setIsActive(true)}>Open editor</button>
        <DeferredMount isActive={isActive}><LazyEditor /></DeferredMount>
      </>;
    }
    function RouteFailure() {
      const error = useRouteError();
      return <p role="alert">{error instanceof Error ? error.message : 'Route unavailable'}</p>;
    }
    const router = createMemoryRouter([{ path: '/', element: <Page />, errorElement: <RouteFailure /> }]);
    renderWithOmc(<RouterProvider router={router} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open editor' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Editor render failed');
    expect(screen.queryByTestId('optional-surface-failure')).toBeNull();
  });

  it('recovers a route module-script error with a guarded reload and shows diagnostics if throttled', async () => {
    const attemptSpy = vi.spyOn(chunkRecovery, 'attemptChunkReload');
    function ThrowingRoute(): React.ReactNode {
      throw new TypeError('Importing a module script failed.');
    }

    try {
      attemptSpy.mockReturnValueOnce(true);
      const reloadingRouter = createMemoryRouter([{ path: '/', element: <ThrowingRoute />, errorElement: <RouteErrorPage /> }]);
      const reloadingView = renderWithOmc(
        <ThemeProvider>
          <RouterProvider router={reloadingRouter} />
        </ThemeProvider>,
      );
      await waitFor(() => expect(attemptSpy).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('route-error-message')).toBeNull();
      reloadingView.unmount();

      attemptSpy.mockReturnValueOnce(false);
      const throttledRouter = createMemoryRouter([{ path: '/', element: <ThrowingRoute />, errorElement: <RouteErrorPage /> }]);
      const throttledView = renderWithOmc(
        <ThemeProvider>
          <RouterProvider router={throttledRouter} />
        </ThemeProvider>,
      );
      expect((await screen.findByTestId('route-error-message')).textContent).toBe('Importing a module script failed.');
      throttledView.unmount();

      // A committed route failure during the post-resume grace window defers one guarded retry
      // until grace expires, and cancels that retry if the error screen unmounts first.
      const graceSpy = vi.spyOn(chunkRecovery, 'getChunkReloadGraceRemainingMs').mockReturnValue(20);
      try {
        attemptSpy.mockClear();
        attemptSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
        const deferredRouter = createMemoryRouter([{ path: '/', element: <ThrowingRoute />, errorElement: <RouteErrorPage /> }]);
        const deferredView = renderWithOmc(
          <ThemeProvider>
            <RouterProvider router={deferredRouter} />
          </ThemeProvider>,
        );
        await waitFor(() => expect(attemptSpy).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(attemptSpy).toHaveBeenCalledTimes(2), { timeout: 1000 });
        expect(screen.queryByTestId('route-error-message')).toBeNull();
        deferredView.unmount();

        attemptSpy.mockClear();
        attemptSpy.mockReturnValue(false);
        graceSpy.mockReturnValue(150);
        const cancelledRouter = createMemoryRouter([{ path: '/', element: <ThrowingRoute />, errorElement: <RouteErrorPage /> }]);
        const cancelledView = renderWithOmc(
          <ThemeProvider>
            <RouterProvider router={cancelledRouter} />
          </ThemeProvider>,
        );
        await waitFor(() => expect(attemptSpy).toHaveBeenCalledTimes(1));
        cancelledView.unmount();
        await new Promise((resolve) => window.setTimeout(resolve, 240));
        expect(attemptSpy).toHaveBeenCalledTimes(1);
      } finally {
        graceSpy.mockRestore();
      }
    } finally {
      attemptSpy.mockRestore();
      chunkRecovery.clearChunkReloadPending();
    }
  });
});

describe('AuthGate mobile session continuity', () => {
  it('shows shell loading with an auth hint, retries transient failures without kicking to sign-in, and clears hint on 401', async () => {
    clearReloadRecoveryState();
    writeAuthShellHint(true);
    const sessionSpy = vi.spyOn(api, 'getSession');
    const prefsSpy = vi.spyOn(api, 'getPreferences').mockResolvedValue({});

    try {
      function ConsoleChild() {
        const { setLang } = useI18n();
        return (
          <div data-testid="protected-console">
            Console ready
            <button type="button" onClick={() => setLang('zh')}>Switch lang</button>
          </div>
        );
      }

      // Simulate waking up offline / transient network failure (status 0) across retries.
      sessionSpy.mockRejectedValue(new ApiError('Network request failed', 0));
      const view = renderWithOmc(
        <ThemeProvider>
          <AuthGate>
            <ConsoleChild />
          </AuthGate>
        </ThemeProvider>,
      );

      // While checking with a prior auth hint, ShellLoading stands in rather than the sign-in card
      // and must never mount protected console children before server verification succeeds.
      expect(view.container.querySelector('.shell-loading')).not.toBeNull();
      expect(screen.queryByTestId('protected-console')).toBeNull();

      // After bounded retries fail transiently, AuthGate stays in reconnect mode, keeps the hint,
      // and still never mounts protected content.
      expect(await screen.findByRole('button', { name: 'Retry' }, { timeout: 4000 })).toBeTruthy();
      expect(screen.queryByLabelText('Management key')).toBeNull();
      expect(screen.queryByTestId('protected-console')).toBeNull();
      expect(readAuthShellHint()).toBe(true);

      // Once connectivity returns, clicking Retry enters the console directly.
      sessionSpy.mockResolvedValueOnce({ authenticated: true });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect((await screen.findByTestId('protected-console')).textContent).toContain('Console ready');

      // Changing locale updates `t`, which must never re-run the AuthGate session check.
      const callsBeforeLocaleSwitch = sessionSpy.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Switch lang' }));
      await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
      expect(sessionSpy.mock.calls.length).toBe(callsBeforeLocaleSwitch);

      view.unmount();
      window.localStorage.removeItem('omc-lang');
    } finally {
      window.localStorage.removeItem('omc-lang');
      sessionSpy.mockRestore();
      prefsSpy.mockRestore();
      clearReloadRecoveryState();
    }
  });

  it('withdraws mirrored credential on 401 and ignores stale 401 from abandoned probes via real api.getSession', async () => {
    clearReloadRecoveryState();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const prefsSpy = vi.spyOn(api, 'getPreferences').mockResolvedValue({});
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    try {
      // An actual 401 from the real api.getSession clears the shell hint, withdraws mirrored CPAMC credential, and shows sign-in.
      writeAuthShellHint(true);
      window.localStorage.setItem('cli-proxy-auth', JSON.stringify({ managementKey: 'stale-secret' }));
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'authentication required' }, 401));
      const rejectedView = renderWithOmc(
        <ThemeProvider>
          <AuthGate>
            <div data-testid="protected-console">Console ready</div>
          </AuthGate>
        </ThemeProvider>,
      );
      expect(await screen.findByLabelText('Management key')).toBeTruthy();
      expect(readAuthShellHint()).toBe(false);
      expect(window.localStorage.getItem('cli-proxy-auth')).toBeNull();
      rejectedView.unmount();

      // A stale 401 from an abandoned reconnect probe (exercising real api.getSession) must never
      // invoke the global unauthorized handler, sign out a subsequent login, or clear its mirror.
      writeAuthShellHint(true);
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
      const staleView = renderWithOmc(
        <ThemeProvider>
          <AuthGate>
            <div data-testid="protected-console">Console ready</div>
          </AuthGate>
        </ThemeProvider>,
      );
      const retryBtn = await screen.findByRole('button', { name: 'Retry' }, { timeout: 4000 });
      let resolveStaleFetch!: (response: Response) => void;
      fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveStaleFetch = resolve; }));
      fireEvent.click(retryBtn);
      fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }));
      const loginSpy = vi.spyOn(api, 'login').mockResolvedValueOnce({ authenticated: true });
      try {
        const keyInput = await screen.findByLabelText('Management key');
        fireEvent.change(keyInput, { target: { value: 'valid-secret' } });
        fireEvent.submit(keyInput.closest('form')!);
        expect((await screen.findByTestId('protected-console')).textContent).toContain('Console ready');
        window.localStorage.setItem('cli-proxy-auth', JSON.stringify({ managementKey: 'fresh-secret' }));

        // Stale HTTP 401 response settles through real api.getSession after login succeeded: must be ignored.
        await act(async () => {
          resolveStaleFetch(jsonResponse({ error: 'authentication required' }, 401));
        });
        expect(screen.getByTestId('protected-console').textContent).toContain('Console ready');
        expect(window.localStorage.getItem('cli-proxy-auth')).toContain('fresh-secret');
      } finally {
        window.localStorage.removeItem('cli-proxy-auth');
        loginSpy.mockRestore();
        staleView.unmount();
      }
    } finally {
      window.localStorage.removeItem('cli-proxy-auth');
      fetchSpy.mockRestore();
      prefsSpy.mockRestore();
      clearReloadRecoveryState();
    }
  });
});

describe('SummaryStrip', () => {
  it('renders total and status items with status dots and dividers', () => {
    const { container } = render(
      <SummaryStrip
        total="共 6 个"
        totalTestId="summary-total"
        items={[
          { label: '正常 4 个', tone: 'healthy', testId: 'healthy-item' },
          { label: '需要关注 2', tone: 'attention', testId: 'attention-item' },
        ]}
      />,
    );

    expect(screen.getByTestId('summary-total').textContent).toBe('共 6 个');
    expect(screen.getByTestId('healthy-item').textContent).toBe('正常 4 个');
    expect(screen.getByTestId('attention-item').textContent).toBe('需要关注 2');

    // Dividers between total and items
    const dividers = container.querySelectorAll('[class*="summary-divider"]');
    expect(dividers.length).toBe(2);

    // Status dots inside healthy and attention items
    const healthyDot = screen.getByTestId('healthy-item').querySelector('[class*="status-dot"]');
    const attentionDot = screen.getByTestId('attention-item').querySelector('[class*="status-dot"]');
    expect(healthyDot).not.toBeNull();
    expect(attentionDot).not.toBeNull();
  });

  it('renders subcomponents and preserves custom test IDs', () => {
    render(
      <SummaryStrip>
        <SummaryStrip.Total testId="keys-count">共 1 个密钥</SummaryStrip.Total>
        <SummaryStrip.Divider />
        <SummaryStrip.Item tone="healthy" testId="active-key">
          24 小时内 1 个在用
        </SummaryStrip.Item>
      </SummaryStrip>,
    );

    expect(screen.getByTestId('keys-count').textContent).toBe('共 1 个密钥');
    expect(screen.getByTestId('active-key').textContent).toBe('24 小时内 1 个在用');
    expect(screen.getByTestId('active-key').querySelector('[class*="status-dot"]')).not.toBeNull();
  });
});

describe('MaskedText', () => {
  it('keeps a reveal only while the forms it was opened for are unchanged', () => {
    const props = { masked: 'op•••r@example.com', value: 'operator@example.com', revealLabel: 'Show account', hideLabel: 'Hide account' };
    const { rerender } = render(<MaskedText {...props} />);
    fireEvent.click(screen.getByRole('button', { name: props.masked }));
    expect(screen.getByText(props.value)).toBeTruthy();

    // A re-render of the same pair keeps the operator's reveal.
    rerender(<MaskedText {...props} />);
    expect(screen.getByText(props.value)).toBeTruthy();

    // A changed mask or value is a different thing to reveal, so it starts masked again.
    rerender(<MaskedText {...props} masked="op•••r@example.org" />);
    expect(screen.queryByText(props.value)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'op•••r@example.org' }));
    rerender(<MaskedText {...props} masked="op•••r@example.org" value="owner@example.com" />);
    expect(screen.queryByText('owner@example.com')).toBeNull();
    expect(screen.getByText('op•••r@example.org')).toBeTruthy();
  });

  it('is plain text when nothing is hidden', () => {
    render(<MaskedText masked="Team seat" value="Team seat" revealLabel="Show account" hideLabel="Hide account" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Team seat')).toBeTruthy();
  });
});

describe('RemoteImage', () => {
  it('holds the mark’s box with the console placeholder until the bytes arrive', () => {
    const { container } = render(<RemoteImage src="https://cdn.example/plugin.png" size={24} />);
    const frame = container.querySelector<HTMLElement>('[data-remote-image="loading"]')!;
    expect(frame.style.width).toBe('24px');
    expect(frame.querySelector('.placeholder')).not.toBeNull();

    fireEvent.load(frame.querySelector('img')!);

    expect(frame.getAttribute('data-remote-image')).toBe('loaded');
    expect(frame.querySelector('.placeholder')).toBeNull();
    expect(frame.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/plugin.png');
  });

  it('does not hold a source that is already here', () => {
    const { container } = render(<RemoteImage src="data:image/svg+xml,%3Csvg/%3E" size="100%" />);
    expect(container.querySelector('[data-remote-image="loaded"]')).not.toBeNull();
    expect(container.querySelector('.placeholder')).toBeNull();
  });

  it('mounts a previously settled remote source in a single pass without flashing a placeholder', () => {
    const settledUrl = 'https://cdn.example/settled-provider-mark.png';
    const first = render(<RemoteImage src={settledUrl} size={20} />);
    expect(first.container.querySelector('[data-remote-image="loading"]')).not.toBeNull();
    fireEvent.load(first.container.querySelector('img')!);
    expect(first.container.querySelector('[data-remote-image="loaded"]')).not.toBeNull();
    first.unmount();

    const second = render(<RemoteImage src={settledUrl} size={20} />);
    expect(second.container.querySelector('[data-remote-image="loaded"]')).not.toBeNull();
    expect(second.container.querySelector('.placeholder')).toBeNull();
  });

  it('keeps probing a settled masked source so mid-session failures still fall back', () => {
    const probes: HTMLImageElement[] = [];
    const NativeImage = window.Image;
    vi.spyOn(window, 'Image').mockImplementation(function MockImage() {
      const img = new NativeImage();
      probes.push(img);
      return img;
    } as unknown as typeof Image);

    const maskedUrl = 'https://cdn.example/masked-plugin.svg';
    const first = render(
      <MarkArtwork
        artworks={[{ url: maskedUrl, isMono: true }]}
        size={20}
        fallback={<span data-fallback="" />}
      />,
    );
    expect(first.container.querySelector('[data-remote-image="loading"]')).not.toBeNull();
    act(() => {
      probes[0].onload?.(new Event('load'));
    });
    expect(first.container.querySelector('[data-remote-image="loaded"]')).not.toBeNull();
    first.unmount();

    // Second mount starts ready immediately without flashing a placeholder, yet still probes.
    const second = render(
      <MarkArtwork
        artworks={[{ url: maskedUrl, isMono: true }]}
        size={20}
        fallback={<span data-fallback="" />}
      />,
    );
    expect(second.container.querySelector('[data-remote-image="loaded"]')).not.toBeNull();
    expect(second.container.querySelector('.placeholder')).toBeNull();
    expect(probes).toHaveLength(2);

    act(() => {
      probes[1].onerror?.(new Event('error'));
    });
    expect(second.container.querySelector('[data-fallback]')).not.toBeNull();
  });

  it('hands a failed source back, so the next candidate and then the fallback draw', () => {
    const { container } = render(
      <MarkArtwork
        artworks={[{ url: 'https://cdn.example/first.png', isMono: false }, { url: 'https://cdn.example/second.png', isMono: false }]}
        size={20}
        fallback={<span data-fallback="" />}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/first.png');

    fireEvent.error(container.querySelector('img')!);

    const second = container.querySelector('img')!;
    expect(second.getAttribute('src')).toBe('https://cdn.example/second.png');
    expect(container.querySelector('.placeholder')).not.toBeNull();

    fireEvent.error(second);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-fallback]')).not.toBeNull();
    expect(container.querySelector('.placeholder')).toBeNull();
  });
});

describe('PageHeader', () => {
  it('renders a text subtitle in a paragraph element', () => {
    render(<PageHeader title="AI 提供商" subtitle="5 个提供商，8 个模型" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'AI 提供商' });
    expect(heading).toBeTruthy();

    const subtitle = document.querySelector('.terminal-subtitle');
    expect(subtitle?.tagName.toLowerCase()).toBe('p');
    expect(subtitle?.textContent).toBe('5 个提供商，8 个模型');
  });

  it('renders a SummaryStrip child under the title without paragraph wrapping', () => {
    const { container } = render(
      <PageHeader title="OAuth 管理">
        <SummaryStrip total="共 6 个" items={[{ label: '正常 4 个', tone: 'healthy' }]} />
      </PageHeader>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'OAuth 管理' })).toBeTruthy();
    expect(container.querySelector('p.terminal-subtitle')).toBeNull();
    expect(container.querySelector('[class*="summary-strip"]')).not.toBeNull();
    expect(screen.getByText('共 6 个')).toBeTruthy();
  });

  it('renders a rich subtitle node in a div', () => {
    const { container } = render(
      <PageHeader title="OAuth 管理" subtitle={<SummaryStrip total="共 6 个" />} />,
    );

    const subtitle = container.querySelector('.terminal-subtitle');
    expect(subtitle?.tagName.toLowerCase()).toBe('div');
    expect(subtitle?.querySelector('[class*="summary-strip"]')).not.toBeNull();
  });
});

describe('Base UI Select, Tabs, Combobox & AutoComplete contracts', () => {
  it('keeps an initially empty controlled Select synchronized across external updates and clear', () => {
    function Harness() {
      const [val, setVal] = React.useState<string | undefined>(undefined);
      return (
        <div>
          <button type="button" onClick={() => setVal('claude')}>Set Claude</button>
          <Select
            aria-label="Protocol"
            allowClear
            placeholder="All protocols"
            value={val}
            onChange={(next) => setVal(next)}
            options={[
              { value: 'alpha', label: 'Alpha' },
              { value: 'claude', label: 'Claude' },
            ]}
          />
        </div>
      );
    }
    renderWithOmc(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Protocol' });
    expect(trigger.textContent).toContain('All protocols');

    fireEvent.click(screen.getByRole('button', { name: 'Set Claude' }));
    expect(trigger.textContent).toContain('Claude');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(trigger.textContent).toContain('All protocols');
  });

  it('retains visited Tabs panel state when destroyOnHidden is false and discards it when true', () => {
    function CounterPanel({ label }: { label: string }) {
      const [count, setCount] = React.useState(0);
      return (
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          {label}: {count}
        </button>
      );
    }
    const { rerender } = renderWithOmc(
      <Tabs
        defaultActiveKey="tail"
        items={[
          { key: 'tail', label: 'Tail', children: <CounterPanel label="Tail count" /> },
          { key: 'errors', label: 'Errors', children: <CounterPanel label="Error count" /> },
        ]}
      />,
    );

    // Lazy initial mount: inactive Errors panel is not mounted before first visit.
    expect(screen.queryByRole('button', { name: /Error count/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tail count: 0' }));
    expect(screen.getByRole('button', { name: 'Tail count: 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Errors' }));
    expect(screen.getByRole('button', { name: 'Error count: 0' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Tail' }));
    expect(screen.getByRole('button', { name: 'Tail count: 1' })).toBeTruthy();

    rerender(
      <Tabs
        destroyOnHidden
        defaultActiveKey="tail"
        items={[
          { key: 'tail', label: 'Tail', children: <CounterPanel label="Tail count" /> },
          { key: 'errors', label: 'Errors', children: <CounterPanel label="Error count" /> },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Errors' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tail' }));
    expect(screen.getByRole('button', { name: 'Tail count: 0' })).toBeTruthy();
  });

  it('wires aria-activedescendant on Combobox and AutoComplete and ignores Enter during IME composition', async () => {
    const onComboChange = vi.fn();
    const onAutoSelect = vi.fn();
    renderWithOmc(
      <div>
        <Combobox
          aria-label="Model picker"
          showSearch
          open
          options={[
            { value: 'gpt-5', label: 'GPT-5' },
            { value: 'claude-4', label: 'Claude 4' },
          ]}
          onChange={onComboChange}
        />
        <AutoComplete
          aria-label="Alias target"
          value="g"
          options={[
            { value: 'gpt-5', label: 'GPT-5' },
            { value: 'gemini', label: 'Gemini' },
          ]}
          onSelect={onAutoSelect}
        />
      </div>,
    );

    const searchInput = await screen.findByRole('combobox', { name: 'Model picker search' });
    const firstOptId = searchInput.getAttribute('aria-activedescendant');
    expect(firstOptId).toBeTruthy();
    expect(document.getElementById(firstOptId!)?.textContent).toContain('GPT-5');

    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    const secondOptId = searchInput.getAttribute('aria-activedescendant');
    expect(secondOptId).toBeTruthy();
    expect(secondOptId).not.toBe(firstOptId);
    expect(document.getElementById(secondOptId!)?.textContent).toContain('Claude 4');

    // IME composition confirmation must not commit the highlighted option.
    fireEvent.keyDown(searchInput, { key: 'Enter', isComposing: true });
    expect(onComboChange).not.toHaveBeenCalled();

    fireEvent.keyDown(searchInput, { key: 'Enter' });
    expect(onComboChange).toHaveBeenCalledWith('claude-4', expect.objectContaining({ value: 'claude-4' }));

    const autoInput = screen.getByRole('combobox', { name: 'Alias target' });
    fireEvent.focus(autoInput);
    await waitFor(() => expect(autoInput.getAttribute('aria-expanded')).toBe('true'));
    const autoActiveId = autoInput.getAttribute('aria-activedescendant');
    expect(autoActiveId).toBeTruthy();
    expect(document.getElementById(autoActiveId!)?.textContent).toContain('GPT-5');

    fireEvent.keyDown(autoInput, { key: 'Enter', isComposing: true });
    expect(onAutoSelect).not.toHaveBeenCalled();
  });

  it('layers AppModal above AppDrawer even when the modal portal mounted first', () => {
    installOmcApi();
    let setModalOpen!: (open: boolean) => void;
    let setDrawerOpen!: (open: boolean) => void;
    const Host = () => {
      const [modalOpen, _setModalOpen] = React.useState(true);
      const [drawerOpen, _setDrawerOpen] = React.useState(false);
      setModalOpen = _setModalOpen;
      setDrawerOpen = _setDrawerOpen;
      return (
        <>
          <AppModal open={modalOpen} title="First modal" onCancel={() => _setModalOpen(false)}>
            modal body
          </AppModal>
          <AppDrawer open={drawerOpen} widthKey="test_stacking" title="Later drawer" onClose={() => _setDrawerOpen(false)}>
            drawer body
          </AppDrawer>
        </>
      );
    };
    renderWithOmc(<Host />);

    // Close modal (kept mounted via keepMounted), open drawer later, then reopen modal.
    act(() => setModalOpen(false));
    act(() => setDrawerOpen(true));
    act(() => setModalOpen(true));

    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!;
    const dialogBackdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]')!;
    const dialogViewport = document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')!;
    expect(Number(dialogBackdrop.style.zIndex)).toBeGreaterThan(Number(sheet.style.zIndex));
    expect(Number(dialogViewport.style.zIndex)).toBeGreaterThan(Number(dialogBackdrop.style.zIndex));

    // Pressing Escape dismisses only the top modal and keeps the underlying drawer open.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-slot="dialog-content"][data-open]')).toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"][data-open]')).not.toBeNull();

    // A second Escape dismisses the now-topmost drawer.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-slot="sheet-content"][data-open]')).toBeNull();
  });

  it('dismisses only the topmost sibling ConfirmDialogHost or equal-zIndex AppModal on Escape', () => {
    installOmcApi();
    let setDrawerOpen!: (open: boolean) => void;
    const Host = () => {
      const [drawerOpen, _setDrawerOpen] = React.useState(true);
      const [firstModalOpen, setFirstModalOpen] = React.useState(true);
      const [secondModalOpen, setSecondModalOpen] = React.useState(true);
      setDrawerOpen = _setDrawerOpen;
      return (
        <>
          <AppDrawer open={drawerOpen} widthKey="test_confirm_stack" title="Base drawer" onClose={() => _setDrawerOpen(false)}>
            drawer body
          </AppDrawer>
          <AppModal open={firstModalOpen} title="Lower modal" onCancel={() => setFirstModalOpen(false)}>
            lower modal
          </AppModal>
          <AppModal open={secondModalOpen} title="Upper modal" onCancel={() => setSecondModalOpen(false)}>
            upper modal
          </AppModal>
        </>
      );
    };
    renderWithOmc(<Host />);

    act(() => {
      confirmModal({ title: 'Confirm action' });
    });

    // Escape closes ConfirmDialogHost (1081) without closing either modal or the drawer.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-slot="alert-dialog-content"][data-open]')).toBeNull();
    expect(document.querySelectorAll('[data-slot="dialog-content"][data-open]')).toHaveLength(2);
    expect(document.querySelector('[data-slot="sheet-content"][data-open]')).not.toBeNull();

    // Next Escape closes only the later-DOM equal-zIndex modal ("Upper modal"), keeping "Lower modal" open.
    fireEvent.keyDown(document, { key: 'Escape' });
    const remainingDialogs = [...document.querySelectorAll('[data-slot="dialog-content"][data-open]')];
    expect(remainingDialogs).toHaveLength(1);
    expect(remainingDialogs[0].textContent).toContain('Lower modal');
    expect(document.querySelector('[data-slot="sheet-content"][data-open]')).not.toBeNull();

    // Next Escape closes "Lower modal", leaving only the drawer open.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-slot="dialog-content"][data-open]')).toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"][data-open]')).not.toBeNull();
    act(() => setDrawerOpen(false));
  });

  it('keeps sheet centering insets on AppModal until its exit transition completes on outside press', async () => {
    installOmcApi();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
    try {
      let setDrawerOpen!: (open: boolean) => void;
      let setModalOpen!: (open: boolean) => void;
      const Host = () => {
        const [drawerOpen, _setDrawerOpen] = React.useState(true);
        const [modalOpen, _setModalOpen] = React.useState(false);
        setDrawerOpen = _setDrawerOpen;
        setModalOpen = _setModalOpen;
        return (
          <AppDrawer open={drawerOpen} width="wide" widthKey="test_span_close" title="Detail drawer" onClose={() => _setDrawerOpen(false)}>
            <AppModal open={modalOpen} size="large" title="Usage forecast" onCancel={() => _setModalOpen(false)}>
              modal body
            </AppModal>
          </AppDrawer>
        );
      };
      renderWithOmc(<Host />);

      const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!;
      vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({
        left: 512,
        right: 1272,
        top: 8,
        bottom: 712,
        width: 760,
        height: 704,
        x: 512,
        y: 8,
        toJSON: () => ({}),
      });

      act(() => setModalOpen(true));

      const dialogViewport = document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')!;
      const dialogContent = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
      expect(dialogViewport.style.paddingInlineStart).toBe('512px');
      expect(dialogViewport.style.paddingInlineEnd).toBe('8px');

      let resolveExit!: () => void;
      const exitFinished = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      dialogContent.getAnimations = () => [
        {
          finished: exitFinished,
          effect: { getTiming: () => ({ duration: 180, iterations: 1 }) },
        } as unknown as Animation,
      ];

      fireEvent.pointerDown(dialogViewport, { button: 0 });
      fireEvent.click(dialogViewport);

      expect(dialogContent.hasAttribute('data-open')).toBe(false);
      expect(sheet.hasAttribute('data-open')).toBe(true);
      expect(dialogViewport.style.paddingInlineStart).toBe('512px');
      expect(dialogViewport.style.paddingInlineEnd).toBe('8px');

      await act(async () => {
        resolveExit();
        await exitFinished;
      });

      await waitFor(() => {
        expect(dialogViewport.style.paddingInlineStart).toBe('');
        expect(dialogViewport.style.paddingInlineEnd).toBe('');
      });

      // Reopening inside an open drawer re-applies the sheet centering insets,
      // while closing the drawer leaves the page clean for subsequent tests.
      act(() => setModalOpen(true));
      expect(dialogContent.hasAttribute('data-open')).toBe(true);
      expect(dialogViewport.style.paddingInlineStart).toBe('512px');
      expect(dialogViewport.style.paddingInlineEnd).toBe('8px');
      act(() => setModalOpen(false));
      act(() => setDrawerOpen(false));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    }
  });
});

describe('RoutingPanel loading topology', () => {
  it('renders the topology skeleton inside RoutingPanel while initial routing data is pending and swaps to the live map on resolve', async () => {
    const api = installOmcApi();
    const held = api.hold('GET', '/usage/routing');

    renderWithOmc(<ThemeProvider><RoutingPanel /></ThemeProvider>);

    const panel = screen.getByTestId('dashboard-routing');
    const skeleton = screen.getByTestId('routing-skeleton');
    expect(panel.contains(skeleton)).toBe(true);
    expect(skeleton.closest('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('routing-map')).toBeNull();

    await held.arrived;
    held.release(json({
      as_of_ms: 1_760_000_000_000,
      window_ms: 60_000,
      records: [],
      cooldowns: [],
      has_more: false,
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('routing-skeleton')).toBeNull();
      expect(screen.getByTestId('routing-map')).toBeTruthy();
    });
  });
});

describe('Combobox empty-string option selection', () => {
  it('displays and marks an explicit empty-string option when value is "" and shows placeholder otherwise', () => {
    const { rerender } = renderWithOmc(
      <Combobox
        aria-label="Warmup model"
        value=""
        open
        options={[
          { value: '', label: 'Auto (gpt-6-luna)' },
          { value: 'gpt-6-luna', label: 'gpt-6-luna' },
        ]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Warmup model' });
    expect(trigger.textContent).toContain('Auto (gpt-6-luna)');
    const autoOption = screen.getByRole('option', { name: 'Auto (gpt-6-luna)' });
    expect(autoOption.getAttribute('aria-selected')).toBe('true');

    rerender(
      <Combobox
        aria-label="Warmup model"
        value=""
        placeholder="Pick a model"
        options={[
          { value: 'gpt-6-luna', label: 'gpt-6-luna' },
        ]}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Warmup model' }).textContent).toContain('Pick a model');
  });
});

describe('DataTable row slots', () => {
  it('marks rendered data rows with data-slot="table-row" and omits it from empty-state rows', () => {
    const columns = [{ title: 'Name', dataIndex: 'name', key: 'name' }] as const;
    const CustomRow = (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr data-custom-row="true" {...props} />;

    const { container, rerender } = render(
      <DataTable<{ id: string; name: string }>
        rowKey="id"
        columns={columns}
        dataSource={[]}
        locale={{ emptyText: 'Nothing yet' }}
      />,
    );
    expect(container.querySelectorAll('[data-slot="table-row"]')).toHaveLength(0);

    rerender(
      <DataTable<{ id: string; name: string }>
        rowKey="id"
        columns={columns}
        dataSource={[{ id: 'p1', name: 'Alpha' }]}
        components={{ body: { row: CustomRow } }}
      />,
    );
    const rows = container.querySelectorAll('tbody [data-slot="table-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-row-key')).toBe('p1');
    expect(rows[0].getAttribute('data-custom-row')).toBe('true');
  });
});

describe('Select and Combobox inline action controls', () => {
  it('elevates Select clear button above the trigger touch pseudo-element and clears without opening', () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    renderWithOmc(
      <Select
        aria-label="Choose option"
        value="alpha"
        allowClear
        onChange={onChange}
        onOpenChange={onOpenChange}
        options={[{ value: 'alpha', label: 'Alpha' }]}
      />,
    );
    const clearBtn = screen.getByRole('button', { name: 'Clear' });
    expect(clearBtn.className).toContain('relative');
    expect(clearBtn.className).toContain('z-[1]');
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
  });

  it('elevates Combobox tag-remove and clear buttons above the trigger touch pseudo-element', () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    renderWithOmc(
      <Combobox
        aria-label="Models"
        mode="multiple"
        allowClear
        value={['m1', 'm2']}
        onChange={onChange}
        onOpenChange={onOpenChange}
        options={[
          { value: 'm1', label: 'Model One' },
          { value: 'm2', label: 'Model Two' },
        ]}
      />,
    );
    const removeOne = screen.getByRole('button', { name: 'Remove m1' });
    const clearAll = screen.getByRole('button', { name: 'Clear' });
    expect(removeOne.className).toContain('relative');
    expect(removeOne.className).toContain('z-[1]');
    expect(clearAll.className).toContain('relative');
    expect(clearAll.className).toContain('z-[1]');

    fireEvent.click(removeOne);
    expect(onChange.mock.calls[0][0]).toEqual(['m2']);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);

    fireEvent.click(clearAll);
    expect(onChange.mock.calls[1][0]).toEqual([]);
  });
});

describe('DashboardTrendChart native SVG sparkline', () => {
  it('renders monotone SVG paths synchronously and reveals bucket tooltip on pointer hover', () => {
    const surface = renderWithOmc(
      <ThemeProvider>
        <DashboardTrendChart
          ariaLabel="Total requests"
          height={64}
          points={[
            { t: 1_700_000_000_000, v: 12, f: 0, tokens: 120 },
            { t: 1_700_000_060_000, v: 48, f: 0, tokens: 480 },
            { t: 1_700_000_120_000, v: 24, f: 0, tokens: 240 },
          ]}
          pick={(p) => p.v ?? 0}
          label={(t) => `bucket-${t}`}
          format={(v) => `${v} reqs`}
        />
      </ThemeProvider>,
    );

    const chart = screen.getByRole('img', { name: 'Total requests' });
    chart.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 480, bottom: 64, width: 480, height: 64, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const paths = surface.container.querySelectorAll('svg path');
    expect(paths.length).toBeGreaterThanOrEqual(2);

    // At 480px host width (2x the 240 viewBox), 12px maps to viewBox x=6 -> index 0 (12 reqs),
    // and 240px maps to viewBox x=120 -> index 1 (48 reqs).
    fireEvent.pointerMove(chart, { clientX: 12, clientY: 24, pointerType: 'mouse' });
    expect(screen.getByText('12 reqs')).toBeTruthy();

    fireEvent.pointerMove(chart, { clientX: 240, clientY: 24, pointerType: 'mouse' });
    expect(screen.getByText('bucket-1700000060000')).toBeTruthy();
    expect(screen.getByText('48 reqs')).toBeTruthy();

    fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
    expect(screen.queryByText('48 reqs')).toBeNull();

    // Keyboard navigation selects points with ArrowLeft / ArrowRight / Home / End and clears on Escape.
    expect(chart.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(chart, { key: 'End' });
    expect(screen.getByText('24 reqs')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(screen.getByText('48 reqs')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByText('12 reqs')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.queryByText('12 reqs')).toBeNull();
  });

  it('plots cache-rate percentages across idle buckets with dash readouts for them', () => {
    const surface = renderWithOmc(
      <ThemeProvider>
        <DashboardTrendChart
          ariaLabel="Cache rate"
          height={44}
          fit={{ minSpan: 10, floor: 0, ceiling: 100, weight: (p) => p.tokens ?? 0 }}
          points={[
            { t: 1_700_000_000_000, tokens: 0, cache_read: 0 },
            { t: 1_700_000_060_000, tokens: 1000, cache_read: 952, cache_rate: 95.24 },
            { t: 1_700_000_120_000, tokens: 500, cache_read: 400, cache_rate: 80 },
            { t: 1_700_000_180_000, tokens: 0, cache_read: 0 },
            { t: 1_700_000_240_000, tokens: 200, cache_read: 84, cache_rate: 42 },
            { t: 1_700_000_300_000, tokens: 0, cache_read: 0 },
            { t: 1_700_000_360_000, tokens: 300, cache_read: 0, cache_rate: 0 },
          ]}
          pick={(p) => p.cache_rate ?? null}
          label={(t) => `bucket-${t}`}
          format={formatCacheRate}
        />
      </ThemeProvider>,
    );

    const chart = screen.getByRole('img', { name: 'Cache rate' });
    chart.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 480, bottom: 44, width: 480, height: 44, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    // Idle buckets never split the curve into fragments.
    const curve = surface.container.querySelector('svg path[fill="none"]');
    expect((curve?.getAttribute('d')?.match(/M/g) ?? []).length).toBe(1);

    // Pointer hover on index 0 (null bucket at x=12px) shows '—' without an active curve dot.
    fireEvent.pointerMove(chart, { clientX: 12, clientY: 20, pointerType: 'mouse' });
    expect(screen.getByText('bucket-1700000000000')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(surface.container.querySelector('[data-slot="sparkline-active-dot"]')).toBeNull();

    // Pointer hover on index 1 (95.24% at x=88px) renders active dot and percentage readout.
    fireEvent.pointerMove(chart, { clientX: 88, clientY: 20, pointerType: 'mouse' });
    expect(screen.getByText('95.2%')).toBeTruthy();
    expect(surface.container.querySelector('[data-slot="sparkline-active-dot"]')).not.toBeNull();

    fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
    expect(screen.queryByText('95.2%')).toBeNull();

    // Keyboard Home lands on index 0 (null cache_rate): shows '—' without an active curve dot.
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByText('bucket-1700000000000')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(surface.container.querySelector('[data-slot="sparkline-active-dot"]')).toBeNull();

    // Stepping to index 1 (95.24) renders active dot and formats percentage to 95.2%.
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(screen.getByText('95.2%')).toBeTruthy();
    expect(surface.container.querySelector('[data-slot="sparkline-active-dot"]')).not.toBeNull();

    // Stepping to End (measured 0%) formats as 0% and keeps the active dot.
    fireEvent.keyDown(chart, { key: 'End' });
    expect(screen.getByText('0%')).toBeTruthy();
    expect(surface.container.querySelector('[data-slot="sparkline-active-dot"]')).not.toBeNull();
    fireEvent.keyDown(chart, { key: 'Escape' });

    // An all-idle window draws only the baseline and prints '—' on selection.
    const emptySurface = renderWithOmc(
      <ThemeProvider>
        <DashboardTrendChart
          ariaLabel="Empty cache rate"
          height={44}
          fit={{ minSpan: 10, floor: 0, ceiling: 100, weight: (p) => p.tokens ?? 0 }}
          points={[
            { t: 1_700_000_000_000, tokens: 0, cache_read: 0 },
            { t: 1_700_000_060_000, tokens: 0, cache_read: 0 },
          ]}
          pick={(p) => p.cache_rate ?? null}
          label={(t) => `empty-${t}`}
          format={formatCacheRate}
        />
      </ThemeProvider>,
    );
    expect(emptySurface.container.querySelectorAll('svg path')).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole('img', { name: 'Empty cache rate' }), { key: 'Home' });
    expect(screen.getByText('empty-1700000000000')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('ShellLoading and LoadingRegion continuity', () => {
  it('renders route-aware dashboard skeleton inside ShellLoading and respects cached collapsed state', () => {
    const originalPath = window.location.pathname;
    window.history.replaceState(null, '', '/');
    try {
      const client = createTestQueryClient();
      client.setQueryData(['preferences'], { omc_sidebar_collapsed: true });
      const { container } = renderWithOmc(
        <ThemeProvider>
          <ShellLoading />
        </ThemeProvider>,
        { client },
      );

      expect(screen.getAllByRole('status')).toHaveLength(1);
      const region = screen.getByRole('status');
      expect(region.getAttribute('aria-busy')).toBe('true');
      expect(region.getAttribute('data-handover')).toBe('true');
      expect(screen.getByTestId('routing-skeleton')).toBeTruthy();
      expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--sider-width')).toBe('58px');
    } finally {
      window.history.replaceState(null, '', originalPath);
    }
  });

  it('renders the standalone authorization frame without a sidebar on /authorize/* routes', () => {
    const originalPath = window.location.pathname;
    window.history.replaceState(null, '', '/authorize/op_test');
    try {
      const { container } = renderWithOmc(
        <ThemeProvider>
          <ShellLoading />
        </ThemeProvider>,
      );

      expect(container.querySelector('aside')).toBeNull();
      expect(screen.queryByTestId('routing-skeleton')).toBeNull();
      expect(screen.getByRole('status').getAttribute('data-handover')).toBe('true');
    } finally {
      window.history.replaceState(null, '', originalPath);
    }
  });

  it('delays isolated loading regions while handing over sequential loading regions without a flash gap', () => {
    let clock = 5_000_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const first = render(
        <I18nProvider>
          <LoadingRegion>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.getByRole('status').getAttribute('data-handover')).toBeNull();

      clock += 50;
      first.unmount();

      clock += 40;
      const second = render(
        <I18nProvider>
          <LoadingRegion>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.getByRole('status').getAttribute('data-handover')).toBe('true');
      second.unmount();

      clock += 1_000;
      const third = render(
        <I18nProvider>
          <LoadingRegion>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.getByRole('status').getAttribute('data-handover')).toBeNull();
      third.unmount();

      // Restoring an earlier clock (or rerunning in the same worker) must not trigger handover via negative elapsed time.
      clock = 100;
      const fourth = render(
        <I18nProvider>
          <LoadingRegion>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.getByRole('status').getAttribute('data-handover')).toBeNull();
      fourth.unmount();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('renders every registered route skeleton archetype cleanly with a single busy status region', () => {
    const bodies = Object.keys(PAGE_SKELETON_REGISTRY) as RouteLoadingBody[];
    for (const body of bodies) {
      const { unmount } = renderWithOmc(
        <ThemeProvider>
          <RouteSkeleton body={body} isImmediate />
        </ThemeProvider>,
      );
      const statuses = screen.getAllByRole('status');
      expect(statuses, `archetype ${body} must expose one status region`).toHaveLength(1);
      expect(statuses[0].getAttribute('aria-busy')).toBe('true');
      expect(statuses[0].getAttribute('data-handover')).toBe('true');
      unmount();
    }
  });

  it('projects cached hidden and reordered sidebar items inside ShellLoading', () => {
    const originalPath = window.location.pathname;
    window.history.replaceState(null, '', '/insights');
    try {
      const client = createTestQueryClient();
      client.setQueryData(['preferences'], {
        omc_nav_hidden: ['/agent', '/playground'],
        omc_nav_order: { operate: ['/model-square', '/dashboard'] },
      });
      const { container } = renderWithOmc(
        <ThemeProvider>
          <ShellLoading />
        </ThemeProvider>,
        { client },
      );

      // 19 static items minus 2 hidden (`/agent`, `/playground`) = 17 rendered rail rows.
      expect(container.querySelectorAll('.shell-loading-nav-item')).toHaveLength(17);
      expect(container.querySelector('.placeholder-insights-rankings')).not.toBeNull();
    } finally {
      window.history.replaceState(null, '', originalPath);
    }
  });

  it('hands over parent-to-child LoadingRegion without remounting and keeps ThreadPlaceholder header inside status', () => {
    let clock = 8_000_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const view = render(
        <I18nProvider>
          <LoadingRegion isLoading>
            <LoadingRegion testId="child-region" isLoading>
              <Placeholder width={120} />
            </LoadingRegion>
          </LoadingRegion>
        </I18nProvider>,
      );

      const childBefore = screen.getByTestId('child-region');
      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(childBefore.getAttribute('role')).toBeNull();

      clock += 50;
      view.rerender(
        <I18nProvider>
          <LoadingRegion isLoading={false}>
            <LoadingRegion testId="child-region" isLoading>
              <Placeholder width={120} />
            </LoadingRegion>
          </LoadingRegion>
        </I18nProvider>,
      );

      const childAfter = screen.getByTestId('child-region');
      expect(childAfter).toBe(childBefore);
      expect(childAfter.getAttribute('role')).toBe('status');
      expect(childAfter.getAttribute('aria-busy')).toBe('true');
      expect(childAfter.getAttribute('data-handover')).toBe('true');
      view.unmount();

      clock += 1_000;
      const standalone = render(
        <I18nProvider>
          <LoadingRegion testId="late-region" isLoading={false}>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.queryByRole('status')).toBeNull();
      standalone.rerender(
        <I18nProvider>
          <LoadingRegion testId="late-region" isLoading>
            <Placeholder width={120} />
          </LoadingRegion>
        </I18nProvider>,
      );
      expect(screen.getByTestId('late-region').getAttribute('data-handover')).toBeNull();
      standalone.unmount();

      clock += 1_000;
      const thread = render(
        <I18nProvider>
          <ThreadPlaceholder hasHeader testId="thread-skel" />
        </I18nProvider>,
      );
      const threadStatus = screen.getByTestId('thread-skel');
      expect(threadStatus.getAttribute('role')).toBe('status');
      expect(threadStatus.getAttribute('data-handover')).toBeNull();
      expect(threadStatus.querySelector('.thread-placeholder-head')).not.toBeNull();
      thread.unmount();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
