import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { RequestBackToTop, RequestCollapsibleHeader, RequestFoldToggle } from '../src/components/usage/RequestFoldControls';
import { createViewFlag } from '../src/components/usage/viewFlag';

/**
 * The request page's scroll-driven flags re-render the elements that show them
 * and not the page that owns them: a fold flips at every change of wheel
 * direction at the top of the list, and the page is the filters, the query and
 * the list.
 */
describe('request list fold flags', () => {
  it('folds the header and swaps the toggle without rendering their owner again', () => {
    const collapse = createViewFlag();
    let ownerRenders = 0;
    const Owner = () => {
      ownerRenders += 1;
      return (
        <I18nProvider>
          <RequestCollapsibleHeader collapse={collapse}>
            <RequestFoldToggle collapse={collapse} onToggle={() => collapse.set((isCollapsed) => !isCollapsed)} />
          </RequestCollapsibleHeader>
        </I18nProvider>
      );
    };
    const { container } = render(<Owner />);
    const header = container.querySelector('.request-collapsible-header')!;
    const rendersAtRest = ownerRenders;
    const labelAtRest = screen.getByRole('button').getAttribute('aria-label');
    expect(header.classList.contains('is-collapsed')).toBe(false);

    act(() => collapse.set(true));
    expect(header.classList.contains('is-collapsed')).toBe(true);
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toBe(labelAtRest);

    act(() => screen.getByRole('button').click());
    expect(header.classList.contains('is-collapsed')).toBe(false);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(labelAtRest);
    expect(ownerRenders).toBe(rendersAtRest);
  });

  it('shows the return to the top once the reader has left it, or while records wait', () => {
    const scrolledDown = createViewFlag();
    const view = render(
      <I18nProvider>
        <RequestBackToTop scrolledDown={scrolledDown} pendingCount={0} onBackToTop={() => {}} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();

    act(() => scrolledDown.set(true));
    expect(screen.getByRole('button').classList.contains('is-live')).toBe(false);

    act(() => scrolledDown.set(false));
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(
      <I18nProvider>
        <RequestBackToTop scrolledDown={scrolledDown} pendingCount={3} onBackToTop={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByRole('button').classList.contains('is-live')).toBe(true);
  });

  it('notifies a subscriber only when the value changes', () => {
    const flag = createViewFlag();
    let notifications = 0;
    const unsubscribe = flag.subscribe(() => { notifications += 1; });
    flag.set(false);
    flag.set(true);
    flag.set(true);
    flag.set((isSet) => !isSet);
    expect([flag.get(), notifications]).toEqual([false, 2]);
    unsubscribe();
    flag.set(true);
    expect(notifications).toBe(2);
  });
});
