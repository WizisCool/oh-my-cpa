import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchInput } from '../src/components/common/SearchInput';

/**
 * Fills the field the way an input method does: the value is set through the property React tracks,
 * and the input event says whether what it holds is still a draft.
 */
function typeInto(input: HTMLElement, value: string, isComposingText: boolean) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  const event = new Event('input', { bubbles: true });
  Object.defineProperty(event, 'isComposing', { value: isComposingText });
  fireEvent(input, event);
}

function Field({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = React.useState('');
  return (
    <SearchInput
      label="Search"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe('SearchInput', () => {
  it('hears the text an input method commits, not the draft it composes', () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search' });

    fireEvent.compositionStart(input);
    typeInto(input, 'ni', true);
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('ni');

    typeInto(input, 'nihao', true);
    expect(onChange).not.toHaveBeenCalled();

    // The input method commits: the field holds the text, and the page hears it once.
    typeInto(input, '你好', false);
    expect(onChange).toHaveBeenLastCalledWith('你好');
    expect((input as HTMLInputElement).value).toBe('你好');
  });

  it('filters on the text a hand types when no input method is composing', () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search' });

    typeInto(input, 'cla', false);
    expect(onChange).toHaveBeenLastCalledWith('cla');
    expect((input as HTMLInputElement).value).toBe('cla');
  });

  it('commits a draft the input method ended without announcing', () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search' });

    fireEvent.compositionStart(input);
    typeInto(input, 'quota', true);
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith('quota');
  });
});
