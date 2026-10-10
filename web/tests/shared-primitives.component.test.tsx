import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDrawer } from '../src/components/common/AppDrawer';
import { EmptyState } from '../src/components/common/EmptyState';
import { SearchInput } from '../src/components/common/SearchInput';
import { SectionHeading } from '../src/components/common/SectionHeading';
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
});
