import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TextareaAutoSize {
  minRows?: number;
  maxRows?: number;
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  status?: 'error' | 'warning';
  autoSize?: boolean | TextareaAutoSize;
  showCount?: boolean;
  monospace?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({
  className,
  style,
  status,
  autoSize,
  showCount = false,
  monospace = false,
  rows,
  maxLength,
  value,
  defaultValue,
  onChange,
  'aria-invalid': ariaInvalid,
  ref,
  ...props
}: TextareaProps) {
  const [uncontrolledLength, setUncontrolledLength] = React.useState(
    () => (defaultValue !== undefined && defaultValue !== null ? String(defaultValue).length : 0),
  );
  const isInvalid = ariaInvalid === true || ariaInvalid === 'true' || status === 'error';

  const minRows = typeof autoSize === 'object' ? autoSize.minRows : (rows ?? 2);
  const maxRows = typeof autoSize === 'object' ? autoSize.maxRows : undefined;
  const autoSizeStyle: React.CSSProperties | undefined = autoSize
    ? {
        fieldSizing: 'content' as React.CSSProperties['fieldSizing'],
        minHeight: minRows ? `calc(${minRows} * 1.5em + 12px)` : undefined,
        maxHeight: maxRows ? `calc(${maxRows} * 1.5em + 12px)` : undefined,
      }
    : undefined;

  const textarea = (
    <textarea
      ref={ref}
      data-slot="textarea"
      rows={autoSize ? minRows : rows}
      maxLength={maxLength}
      value={value}
      defaultValue={defaultValue}
      aria-invalid={isInvalid || ariaInvalid}
      onChange={(event) => {
        if (value === undefined) setUncontrolledLength(event.target.value.length);
        onChange?.(event);
      }}
      style={autoSizeStyle ? { ...autoSizeStyle, ...style } : style}
      className={cn(
        'w-full min-w-0 rounded-md border-0 bg-field px-2.5 py-1.5 text-base leading-normal text-foreground shadow-well',
        'transition-[background-color,box-shadow] resize-y',
        'placeholder:text-muted-foreground',
        'hover:not-focus-visible:not-disabled:bg-field-hover hover:not-focus-visible:not-disabled:shadow-field-hover',
        'focus-visible:outline-none focus-visible:shadow-field-focus',
        'aria-invalid:shadow-field-invalid aria-invalid:focus-visible:shadow-field-invalid-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
        Boolean(autoSize) && 'resize-none',
        monospace && 'font-mono',
        className,
      )}
      {...props}
    />
  );

  if (!showCount) return textarea;

  const length = value !== undefined && value !== null ? String(value).length : uncontrolledLength;
  return (
    <div className="flex flex-col gap-1 w-full">
      {textarea}
      <span className="self-end font-mono text-xs text-meta tabular-nums" aria-hidden="true">
        {maxLength !== undefined ? `${length} / ${maxLength}` : length}
      </span>
    </div>
  );
}
