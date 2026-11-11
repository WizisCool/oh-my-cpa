import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { CheckboxGroup as CheckboxGroupPrimitive } from '@base-ui/react/checkbox-group';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps
  extends Omit<CheckboxPrimitive.Root.Props, 'onCheckedChange' | 'className' | 'children'> {
  onCheckedChange?: (checked: boolean, eventDetails: CheckboxPrimitive.Root.ChangeEventDetails) => void;
  className?: string;
  children?: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}

export function Checkbox({
  className,
  checked,
  defaultChecked,
  indeterminate = false,
  disabled = false,
  onCheckedChange,
  children,
  id,
  name,
  value,
  tabIndex,
  ref,
  ...props
}: CheckboxProps) {
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={id}
      name={name}
      value={value}
      checked={checked}
      defaultChecked={defaultChecked}
      indeterminate={indeterminate}
      disabled={disabled}
      tabIndex={tabIndex}
      data-slot="checkbox"
      onCheckedChange={(next, details) => onCheckedChange?.(next, details)}
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-field text-primary-foreground shadow-well cursor-pointer',
        'transition-[background-color,box-shadow,color]',
        'hover:not-data-disabled:not-data-checked:not-data-indeterminate:bg-field-hover hover:not-data-disabled:not-data-checked:not-data-indeterminate:shadow-field-hover',
        'data-checked:bg-primary data-checked:shadow-none',
        'data-indeterminate:bg-primary data-indeterminate:shadow-none',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        children === undefined && className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="inline-flex items-center justify-center text-current"
      >
        {indeterminate ? (
          <Minus className="size-3 stroke-[2.5]" aria-hidden="true" />
        ) : (
          <Check className="size-3 stroke-[2.5]" aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (children === undefined || children === null || children === false) {
    return box;
  }

  return (
    <label
      data-slot="checkbox-label"
      data-disabled={disabled ? '' : undefined}
      className={cn(
        'inline-flex items-center gap-2 text-base text-foreground select-none cursor-pointer',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {box}
      <span>{children}</span>
    </label>
  );
}

export interface CheckboxGroupOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface CheckboxGroupProps<T extends string = string> {
  value?: T[];
  defaultValue?: T[];
  onValueChange?: (value: T[]) => void;
  options?: readonly CheckboxGroupOption<T>[];
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function CheckboxGroup<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  options,
  disabled = false,
  className,
  children,
  ...ariaProps
}: CheckboxGroupProps<T>) {
  return (
    <CheckboxGroupPrimitive
      data-slot="checkbox-group"
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={(next) => onValueChange?.(next as T[])}
      className={cn('inline-flex flex-wrap items-center gap-x-4 gap-y-2', className)}
      {...ariaProps}
    >
      {options
        ? options.map((option) => (
            <Checkbox key={option.value} value={option.value} disabled={disabled || option.disabled}>
              {option.label}
            </Checkbox>
          ))
        : children}
    </CheckboxGroupPrimitive>
  );
}
