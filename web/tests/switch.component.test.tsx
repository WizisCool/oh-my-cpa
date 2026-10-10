import { Form } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from '../src/components/common/Switch';

describe('Switch', () => {
  it('reports the opposite of the state it is given and leaves that state to its owner', () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} aria-label="Auto refresh" />);
    const control = screen.getByRole('switch', { name: 'Auto refresh' });
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(false);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('is toggled by the label that wraps it', () => {
    const onChange = vi.fn();
    render(<label>Auto refresh <Switch checked={false} onChange={onChange} /></label>);

    fireEvent.click(screen.getByText('Auto refresh'));

    expect(onChange.mock.calls.map(([checked]) => checked)).toEqual([true]);
  });

  it('refuses a change while disabled or while its write is pending', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} disabled onChange={onChange} aria-label="Enabled" />);
    const control = screen.getByRole('switch', { name: 'Enabled' });
    fireEvent.click(control);

    rerender(<Switch checked={false} loading onChange={onChange} aria-label="Enabled" />);
    fireEvent.click(control);

    expect(onChange).not.toHaveBeenCalled();
    expect(control.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps a caller-owned busy state clickable', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} aria-busy onChange={onChange} aria-label="Provider" />);
    const control = screen.getByRole('switch', { name: 'Provider' });

    fireEvent.click(control);

    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is a form field through valuePropName', () => {
    const onValuesChange = vi.fn();
    render(
      <Form initialValues={{ websockets: true }} onValuesChange={onValuesChange}>
        <Form.Item name="websockets" valuePropName="checked" noStyle>
          <Switch aria-label="WebSockets" />
        </Form.Item>
      </Form>,
    );
    const control = screen.getByRole('switch', { name: 'WebSockets' });
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);

    expect(onValuesChange.mock.calls[0][0]).toEqual({ websockets: false });
    expect(control.getAttribute('aria-checked')).toBe('false');
  });
});
