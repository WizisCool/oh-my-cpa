import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderAction } from '../src/components/common/HeaderAction';

/** Hovers the control and runs the clock past the tooltip's open delay. */
function hoverUntilSettled(control: HTMLElement) {
  fireEvent.mouseEnter(control);
  act(() => { vi.advanceTimersByTime(1000); });
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout; the tooltip only needs the observer to exist in order to open.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); });

describe('header action', () => {
  it('names itself to assistive technology and on hover', () => {
    render(<HeaderAction label="Refresh all" />);
    const control = screen.getByRole('button', { name: 'Refresh all' });

    hoverUntilSettled(control);

    expect(screen.getByRole('tooltip').textContent).toBe('Refresh all');
  });

  it('shows the tooltip it is given while keeping its own accessible name', () => {
    render(<HeaderAction label="Theme: Dark" tooltip="Theme" />);

    hoverUntilSettled(screen.getByRole('button', { name: 'Theme: Dark' }));

    expect(screen.getByRole('tooltip').textContent).toBe('Theme');
  });

  // The absence is only a claim once the clock has passed the point where the cases above
  // show one; without the advance this would pass against a control that does have a tooltip.
  it('opens no tooltip when told not to, and stays named', () => {
    render(<HeaderAction label="Open project on GitHub" tooltip={false} href="https://example.test/">1.23k</HeaderAction>);
    const control = screen.getByRole('link', { name: 'Open project on GitHub' });

    hoverUntilSettled(control);

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(control.textContent).toBe('1.23k');
  });
});
