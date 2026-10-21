import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDrawer } from '../src/components/common/AppDrawer';
import { ConfirmAction } from '../src/components/common/ConfirmAction';
import { EmptyState } from '../src/components/common/EmptyState';
import { Meter } from '../src/components/common/Meter';
import { Pager } from '../src/components/common/Pager';
import { Panel } from '../src/components/common/Panel';
import { SearchInput } from '../src/components/common/SearchInput';
import { SectionHeading } from '../src/components/common/SectionHeading';
import { SelectionBar } from '../src/components/common/SelectionBar';
import { Tag, ToggleTag } from '../src/components/common/Tag';
import { Toolbar } from '../src/components/common/Toolbar';
import { I18nProvider } from '../src/i18n';

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

  it('draws no footer when neither slot has content, and sizes itself from the width step', () => {
    render(<I18nProvider><AppDrawer open title="Details" width="narrow" footer={false} footerStart={undefined}>body</AppDrawer></I18nProvider>);
    expect(document.querySelector('.ant-drawer-footer')).toBeNull();
    const panel = document.querySelector<HTMLElement>('.ant-drawer-content-wrapper');
    expect(panel?.style.width).toBe('min(420px, 100vw)');
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
  it('carries its tone and size as classes and hides the glyph from assistive technology', () => {
    const { container } = render(<Tag tone="warn" size="small" icon={<svg />}>Unsaved</Tag>);
    const tag = container.querySelector('.tag')!;
    expect(tag.classList.contains('is-warn')).toBe(true);
    expect(tag.classList.contains('is-small')).toBe(true);
    expect(tag.querySelector('.tag-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(tag.textContent).toBe('Unsaved');
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
  beforeEach(() => {
    window.localStorage.setItem('omc-lang', 'en');
    // The anchored overlay measures its trigger, which jsdom has no observer for.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

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

  it('falls back to a plain confirmation that is not coloured', () => {
    render(
      <I18nProvider>
        <ConfirmAction open title="Save the source?"><button type="button">Save</button></ConfirmAction>
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Confirm' }).classList.contains('ant-btn-dangerous')).toBe(false);
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
    fireEvent.mouseEnter(trigger);
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

describe('Toolbar', () => {
  it('sets trailing controls apart and draws no trailing slot without them', () => {
    const { container, rerender } = render(
      <Toolbar variant="ruled" end={<button type="button">Export</button>}><input aria-label="Search" /></Toolbar>,
    );
    expect(container.querySelector('.toolbar.is-ruled > input')).toBeTruthy();
    expect(container.querySelector('.toolbar-end button')?.textContent).toBe('Export');

    rerender(<Toolbar><input aria-label="Search" /></Toolbar>);

    expect(container.querySelector('.toolbar.is-ruled')).toBeNull();
    expect(container.querySelector('.toolbar-end')).toBeNull();
  });
});

describe('Panel', () => {
  it('draws the header from its title and leaves the inset to the stylesheet', () => {
    const { container } = render(<Panel title="Versions" extra={<button type="button">Check</button>} className="system-card">body</Panel>);
    expect(container.querySelector('.panel.system-card .ant-card-head-title')?.textContent).toBe('Versions');
    expect(container.querySelector('.ant-card-extra button')?.textContent).toBe('Check');
    expect((container.querySelector('.ant-card-body') as HTMLElement).style.padding).toBe('');
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
  // antd's pagination subscribes to breakpoints, which jsdom does not implement.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

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
