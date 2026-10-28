import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router-dom';
import { DeferredMount } from '../src/components/common/DeferredMount';
import { Tooltip } from '../src/components/common/Tooltip';
import { progressTasks } from '../src/utils/progressTasks';
import { AppDrawer } from '../src/components/common/AppDrawer';
import { ConfirmAction } from '../src/components/common/ConfirmAction';
import { EmptyState } from '../src/components/common/EmptyState';
import { Meter } from '../src/components/common/Meter';
import { Pager } from '../src/components/common/Pager';
import { SearchInput } from '../src/components/common/SearchInput';
import { SectionHeading } from '../src/components/common/SectionHeading';
import { SelectionBar } from '../src/components/common/SelectionBar';
import { Tag, ToggleTag } from '../src/components/common/Tag';
import { I18nProvider, useT, type MessageKey } from '../src/i18n';
import { renderWithOmc } from './support/render';

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
    const { container } = render(
      <SearchInput value="prod" onChange={onChange} label="Search requests" placeholder="Model, key or request ID" />,
    );
    expect(screen.getByRole('textbox', { name: 'Search requests' }).getAttribute('placeholder')).toBe('Model, key or request ID');

    fireEvent.click(container.querySelector('.ant-input-clear-icon')!);

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
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <AppDrawer open title="Edit price" onClose={onClose} footerStart="Applies to new requests" footer={<button type="button">Save</button>}>
          body
        </AppDrawer>
      </I18nProvider>,
    );
    expect(document.querySelector('.app-drawer-footer-start')?.textContent).toBe('Applies to new requests');
    expect(document.querySelector('.app-drawer-footer-actions button')?.textContent).toBe('Save');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps showing what it showed while open as it closes, though the caller has cleared it', () => {
    const view = (record: string | null) => (
      <I18nProvider>
        <AppDrawer open={record !== null} title={record} footer={record && <button type="button">Copy {record}</button>}>
          {record && <p>Body of {record}</p>}
        </AppDrawer>
      </I18nProvider>
    );
    const { rerender } = render(view('request 42'));

    rerender(view(null));

    expect(screen.getByText('Body of request 42')).toBeTruthy();
    expect(document.querySelector('.ant-drawer-title')?.textContent).toBe('request 42');
    expect(document.querySelector('.app-drawer-footer-actions button')?.textContent).toBe('Copy request 42');
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
    expect(confirm.classList.contains('ant-btn-dangerous')).toBe(true);

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
      const tooltip = screen.queryByText('Delete key')?.closest('.ant-tooltip');
      expect(!tooltip || /-leave\b/.test(tooltip.className)).toBe(true);
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
    expect(container.querySelector('.ant-pagination-options')).toBeNull();

    fireEvent.click(container.querySelector('.ant-pagination-item-2') as HTMLElement);

    expect(onChange).toHaveBeenCalledWith(2, 20);
  });

  it('steps through pages without a field to type in', () => {
    const { container } = render(<Pager variant="stepped" page={2} pageSize={10} total={48} onChange={() => undefined} />);
    expect(container.querySelector('.ant-pagination-simple')).toBeTruthy();
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
