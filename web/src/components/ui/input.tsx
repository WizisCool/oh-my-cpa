import * as React from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type InputSize = 'default' | 'sm' | 'lg';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix' | 'title'> {
  'data-tip'?: string;
  size?: InputSize;
  variant?: 'filled' | 'borderless';
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  allowClear?: boolean | { clearIcon?: React.ReactNode };
  clearLabel?: string;
  status?: 'error' | 'warning';
  showCount?: boolean;
  monospace?: boolean;
  onPressEnter?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  ref?: React.Ref<HTMLInputElement>;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  default: 'h-8 px-2.5 text-base',
  sm: 'h-7 px-2 text-md',
  lg: 'h-9 px-3 text-base',
};

const FIELD_SURFACE = [
  'w-full min-w-0 rounded-md border-0 bg-field text-foreground shadow-well',
  'transition-[background-color,box-shadow]',
  'placeholder:text-muted-foreground',
  'hover:not-focus-within:not-disabled:bg-field-hover hover:not-focus-within:not-disabled:shadow-field-hover',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export function Input({
  className,
  style,
  size = 'default',
  variant = 'filled',
  type = 'text',
  prefix,
  suffix,
  allowClear = false,
  clearLabel = 'Clear',
  status,
  showCount = false,
  monospace = false,
  disabled,
  readOnly,
  value,
  defaultValue,
  onChange,
  onKeyDown,
  onPressEnter,
  'aria-invalid': ariaInvalid,
  ref,
  ...props
}: InputProps) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const [uncontrolledHasValue, setUncontrolledHasValue] = React.useState(
    () => defaultValue !== undefined && defaultValue !== null && String(defaultValue).length > 0,
  );
  const isInvalid = ariaInvalid === true || ariaInvalid === 'true' || status === 'error';
  const hasAffix = prefix !== undefined || suffix !== undefined || Boolean(allowClear) || (showCount && props.maxLength !== undefined);

  const attachRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [ref],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      onPressEnter?.(event);
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (value === undefined) {
      setUncontrolledHasValue(event.target.value.length > 0);
    }
    onChange?.(event);
  };

  if (!hasAffix) {
    return (
      <input
        ref={attachRef}
        type={type}
        data-slot="input"
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        defaultValue={defaultValue}
        aria-invalid={isInvalid || ariaInvalid}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        style={style}
        className={cn(
          variant === 'borderless'
            ? 'w-full min-w-0 rounded-md border-0 bg-transparent text-foreground shadow-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'
            : [
                FIELD_SURFACE,
                'focus-visible:outline-none focus-visible:shadow-field-focus',
                'aria-invalid:shadow-field-invalid aria-invalid:focus-visible:shadow-field-invalid-focus',
              ],
          SIZE_CLASSES[size],
          monospace && 'font-mono',
          className,
        )}
        {...props}
      />
    );
  }

  const hasValue = value !== undefined
    ? value !== null && String(value).length > 0
    : uncontrolledHasValue;
  const canClear = Boolean(allowClear) && hasValue && !disabled && !readOnly;
  const customClearIcon = typeof allowClear === 'object' ? allowClear.clearIcon : undefined;

  const triggerClear = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const element = innerRef.current;
    if (!element) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, '');
    const synthetic = Object.create(event) as React.ChangeEvent<HTMLInputElement>;
    Object.defineProperty(synthetic, 'target', { value: element });
    Object.defineProperty(synthetic, 'currentTarget', { value: element });
    setUncontrolledHasValue(false);
    onChange?.(synthetic);
    element.focus();
  };

  return (
    <span
      data-slot="input"
      data-disabled={disabled ? '' : undefined}
      data-invalid={isInvalid ? '' : undefined}
      style={style}
      onMouseDown={(event) => {
        if (event.target === innerRef.current || (event.target instanceof Element && event.target.closest('button'))) return;
        event.preventDefault();
        innerRef.current?.focus();
      }}
      className={cn(
        'inline-flex items-center gap-1.5',
        variant === 'borderless'
          ? 'w-full min-w-0 rounded-md border-0 bg-transparent text-foreground shadow-none'
          : [
              FIELD_SURFACE,
              'focus-within:shadow-field-focus',
              isInvalid && 'shadow-field-invalid focus-within:shadow-field-invalid-focus',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-field hover:shadow-well',
            ],
        SIZE_CLASSES[size],
        monospace && 'font-mono',
        className,
      )}
    >
      {prefix !== undefined && prefix !== null && (
        <span data-slot="input-prefix" className="inline-flex items-center shrink-0 text-muted-foreground [&_svg]:size-3.5">
          {prefix}
        </span>
      )}
      <input
        ref={attachRef}
        type={type}
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        defaultValue={defaultValue}
        aria-invalid={isInvalid || ariaInvalid}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 h-full border-0 bg-transparent p-0 text-inherit placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
        {...props}
      />
      {canClear && (
        <button
          type="button"
          data-slot="input-clear"
          aria-label={clearLabel}
          // Clearing is a shortcut for what the keyboard already does in the field, so the button
          // stays out of the tab order and Tab moves on to the next field.
          tabIndex={-1}
          onClick={triggerClear}
          className="inline-flex items-center justify-center shrink-0 border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground cursor-pointer rounded-xs"
        >
          {customClearIcon ?? <X className="size-3.5" aria-hidden="true" />}
        </button>
      )}
      {showCount && props.maxLength !== undefined && (
        <span data-slot="input-count" className="inline-flex items-center shrink-0 font-mono text-xs text-meta tabular-nums select-none" aria-hidden="true">
          {`${value !== undefined && value !== null ? String(value).length : 0} / ${props.maxLength}`}
        </span>
      )}
      {suffix !== undefined && suffix !== null && (
        <span data-slot="input-suffix" className="inline-flex items-center shrink-0 text-muted-foreground [&_svg]:size-3.5">
          {suffix}
        </span>
      )}
    </span>
  );
}

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'suffix'> {
  visibilityToggle?: boolean;
  revealLabel?: string;
  hideLabel?: string;
}

export function PasswordInput({
  visibilityToggle = true,
  revealLabel = 'Show password',
  hideLabel = 'Hide password',
  ...props
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = React.useState(false);
  const label = isVisible ? hideLabel : revealLabel;
  return (
    <Input
      {...props}
      type={isVisible ? 'text' : 'password'}
      suffix={
        visibilityToggle ? (
          <button
            type="button"
            aria-label={label}
            aria-pressed={isVisible}
            onClick={() => setIsVisible((prev) => !prev)}
            className="inline-flex items-center justify-center border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground cursor-pointer rounded-xs"
          >
            {isVisible ? <Eye className="size-3.5" aria-hidden="true" /> : <EyeOff className="size-3.5" aria-hidden="true" />}
          </button>
        ) : undefined
      }
    />
  );
}
