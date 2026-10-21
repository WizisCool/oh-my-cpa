import { Input } from 'antd';
import type { InputProps } from 'antd';
import clsx from 'clsx';
import { SearchOutlined } from '../icons';

export interface SearchInputProps
  extends Omit<InputProps, 'value' | 'onChange' | 'prefix' | 'allowClear' | 'aria-label' | 'type'> {
  value: string;
  /** Receives the text, not the event: every caller filtered on `event.target.value` alone. */
  onChange: (value: string) => void;
  /**
   * Names the field for assistive technology, and is its placeholder unless `placeholder` says
   * something longer. A search field has no visible label, so the name is not optional.
   */
  label: string;
}

/**
 * The console's one filter-as-you-type field: the search glyph, the text, and a clear control.
 *
 * Pages built this from antd's `Input` each time, which is how the glyph came to have three
 * colours, some fields lost their accessible name, and the glyph was announced on a few of them.
 * Width belongs to the caller's layout (`className`); everything inside the frame belongs here.
 * It is a filled field: a search narrows what is already on the page, so it reads as part of the
 * toolbar rather than as a form field asking for input.
 */
export function SearchInput({ value, onChange, label, placeholder, className, ...rest }: SearchInputProps) {
  return (
    <Input
      variant="filled"
      {...rest}
      className={clsx('search-input', className)}
      allowClear
      prefix={<SearchOutlined aria-hidden="true" />}
      aria-label={label}
      placeholder={placeholder ?? label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
