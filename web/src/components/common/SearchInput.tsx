import React from 'react';
import clsx from 'clsx';
import { Input, type InputProps } from '@/components/ui/input';
import { SearchOutlined } from '../icons';

export interface SearchInputProps
  extends Omit<InputProps, 'value' | 'onChange' | 'prefix' | 'allowClear' | 'aria-label' | 'type' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  label: string;
  size?: InputProps['size'] | 'small' | 'middle' | 'large';
}

function isComposing(event: React.ChangeEvent<HTMLInputElement>): boolean {
  return (event.nativeEvent as InputEvent).isComposing === true;
}

export function SearchInput({ value, onChange, label, placeholder, size, className, onBlur, ...rest }: SearchInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = React.useCallback(
    (text: string) => {
      setDraft(null);
      onChange(text);
    },
    [onChange],
  );

  React.useEffect(() => {
    setDraft(null);
  }, [value]);

  const resolvedSize: InputProps['size'] =
    size === 'small' ? 'sm' : size === 'large' ? 'lg' : size === 'middle' ? 'default' : size;

  return (
    <Input
      {...rest}
      size={resolvedSize}
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
      onCompositionStart={() => setDraft(value)}
      onCompositionEnd={(event) => commit(event.currentTarget.value)}
      onBlur={(event) => {
        if (draft !== null) commit(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
}
