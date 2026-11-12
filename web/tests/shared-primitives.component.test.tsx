import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router-dom';
import { DeferredMount } from '../src/components/common/DeferredMount';
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
import { Tag, ToggleTag } from '../src/components/common/Tag';
import { PageHeader } from '../src/components/common/PageHeader';
import { SummaryStrip } from '../src/components/common/SummaryStrip';
import { MaskedText } from '../src/components/common/MaskedText';
import { MarkArtwork } from '../src/components/common/MarkArtwork';
import { RemoteImage } from '../src/components/common/RemoteImage';
import { Select } from '../src/components/ui/select';
import { Tabs } from '../src/components/ui/tabs';
import { Combobox } from '../src/components/ui/combobox';
import { AutoComplete } from '../src/components/ui/autocomplete';
import { I18nProvider, useT, type MessageKey } from '../src/i18n';
import { renderWithOmc } from './support/render';
import { installOmcApi } from './support/omcApi';

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
    expect(container.querySelector('.selection-bar.is-framed')).toBeTruthy();
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
    return <span>{t('toString' as MessageKey)} · {t('no.such.id' as MessageKey, { n: 1 })}</span>;
  }

  it('renders an id the catalog does not define as itself, including a name the prototype carries', () => {
    render(<I18nProvider><UnknownIds /></I18nProvider>);
    expect(document.body.textContent).toContain('toString · no.such.id');
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
    render(<PageHeader title="AI 提供商" subtitle="5 个提供商 · 8 个模型" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'AI 提供商' });
    expect(heading).toBeTruthy();

    const subtitle = document.querySelector('.terminal-subtitle');
    expect(subtitle?.tagName.toLowerCase()).toBe('p');
    expect(subtitle?.textContent).toBe('5 个提供商 · 8 个模型');
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
});

