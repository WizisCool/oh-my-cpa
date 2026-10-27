import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderAction } from '../src/components/common/HeaderAction';

/** Moves a mouse onto the control and runs the clock past the tooltip's open delay. */
function hoverUntilSettled(control: HTMLElement) {
  fireEvent.pointerMove(control, { pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(1000); });
}

/** Whether a tooltip is up: one on its way out keeps its node, in the leave state, under jsdom. */
function isTooltipShown() {
  const tooltip = screen.queryByRole('tooltip')?.closest('.ant-tooltip');
  return Boolean(tooltip) && !/-leave\b|-hidden\b/.test(tooltip!.className);
}

beforeEach(() => {
  vi.useFakeTimers();
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

  // A press is the reader acting, not asking: the hint rose over the menu a press had just opened
  // while the pointer still rested on its trigger. It stays down until the pointer leaves.
  it('puts its tooltip away when pressed and keeps it down until the pointer leaves', () => {
    render(<HeaderAction label="Language" />);
    const control = screen.getByRole('button', { name: 'Language' });
    hoverUntilSettled(control);
    expect(isTooltipShown()).toBe(true);

    fireEvent.pointerDown(control, { pointerType: 'mouse' });
    hoverUntilSettled(control);
    expect(isTooltipShown()).toBe(false);

    fireEvent.pointerLeave(control, { pointerType: 'mouse' });
    hoverUntilSettled(control);
    expect(isTooltipShown()).toBe(true);
  });

  // A keyboard reader has no hover to rest; a visible focus is how they ask for the name.
  it('names itself to a keyboard focus and leaves with it', () => {
    render(<HeaderAction label="Refresh all" />);
    const control = screen.getByRole('button', { name: 'Refresh all' });

    act(() => { control.focus(); });
    expect(isTooltipShown()).toBe(true);
    act(() => { control.blur(); });
    expect(isTooltipShown()).toBe(false);
  });

  // On a touch screen a hint that appears on a tap is a change iOS answers by swallowing the tap.
  it('opens nothing when a finger taps it', () => {
    render(<HeaderAction label="Refresh all" />);
    const control = screen.getByRole('button', { name: 'Refresh all' });

    fireEvent.pointerDown(control, { pointerType: 'touch' });
    fireEvent.click(control);
    act(() => { vi.advanceTimersByTime(1000); });

    expect(screen.queryByRole('tooltip')).toBeNull();
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
