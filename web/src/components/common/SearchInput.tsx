import React from 'react';
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

/** Whether the browser says the field holds something an input method is still composing. */
function isComposing(event: React.ChangeEvent<HTMLInputElement>): boolean {
  return (event.nativeEvent as InputEvent).isComposing === true;
}

/**
 * The console's one filter-as-you-type field: the search glyph, the text, and a clear control.
 *
 * Pages built this from antd's `Input` each time, which is how the glyph came to have three
 * colours, some fields lost their accessible name, and the glyph was announced on a few of them.
 * Width belongs to the caller's layout (`className`); everything inside the frame belongs here.
 * It is a filled field: a search narrows what is already on the page, so it reads as part of the
 * toolbar rather than as a form field asking for input.
 *
 * A phone's input method composes before it commits: the pinyin, kana or accented letters a hand
 * types are drawn as a draft that may become something else entirely. The field draws that draft
 * itself and the page hears only the committed text. Filtering on every draft would redraw the list
 * under the hand - usually to its empty state, since no entry matches a half-typed romanisation -
 * and the render that followed could overwrite the draft the input method was still editing.
 */
export function SearchInput({ value, onChange, label, placeholder, className, onBlur, ...rest }: SearchInputProps) {
  // The draft the input method is composing, shown while the page's own value stays as it was.
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = React.useCallback((text: string) => {
    setDraft(null);
    onChange(text);
  }, [onChange]);

  // The page may set the field from elsewhere - a clear-all, a chosen filter - while a draft is
  // being composed. The page's value is the truth at rest, so the next committed value wins.
  React.useEffect(() => {
    setDraft(null);
  }, [value]);

  return (
    <Input
      variant="filled"
      {...rest}
      className={clsx('search-input', className)}
      allowClear
      prefix={<SearchOutlined aria-hidden="true" />}
      aria-label={label}
      placeholder={placeholder ?? label}
      value={draft ?? value}
      onChange={(event) => {
        if (isComposing(event)) {
          setDraft(event.target.value);
          return;
        }
        commit(event.target.value);
      }}
      // A composition the browser announces starts from the text already in the field; one it only
      // flags on its input event is caught above. Either way the draft is the field's own.
      onCompositionStart={() => setDraft(value)}
      onCompositionEnd={(event) => commit(event.currentTarget.value)}
      onBlur={(event) => {
        // An input method that ends without saying so leaves its text in the field.
        if (draft !== null) commit(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
}
