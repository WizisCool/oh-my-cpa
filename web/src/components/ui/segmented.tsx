import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { cn } from '@/lib/utils';

export interface SegmentedOptionObject<T extends string | number = string> {
  value: T;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export type SegmentedOption<T extends string | number = string> = T | SegmentedOptionObject<T>;

export interface SegmentedProps<T extends string | number = string> {
  options: readonly SegmentedOption<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  size?: 'default' | 'sm' | 'small' | 'middle' | 'large';
  block?: boolean;
  vertical?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  classNames?: { label?: string };
  style?: React.CSSProperties;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

export function Segmented<T extends string | number = string>({
  options,
  value,
  defaultValue,
  onChange,
  size = 'default',
  block = false,
  vertical = false,
  disabled = false,
  id,
  className,
  classNames,
  style,
  ...ariaProps
}: SegmentedProps<T>) {
  const normalized = React.useMemo(
    () =>
      options.map((item) =>
        typeof item === 'object' && item !== null && 'value' in item
          ? item
          : ({ value: item, label: String(item) } as SegmentedOptionObject<T>),
      ),
    [options],
  );

  const isSmall = size === 'sm' || size === 'small';

  return (
    <RadioGroupPrimitive<T>
      id={id}
      data-slot="segmented"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      value={value}
      defaultValue={defaultValue ?? normalized[0]?.value}
      disabled={disabled}
      onValueChange={(next) => onChange?.(next)}
      style={style}
      className={cn(
        'inline-flex rounded-md bg-field p-0.5 shadow-well select-none',
        vertical ? 'flex-col items-stretch' : 'items-center',
        block && 'flex w-full',
        className,
      )}
      {...ariaProps}
    >
      {normalized.map((option) => (
        <RadioPrimitive.Root<T>
          key={String(option.value)}
          data-slot="segmented-item"
          value={option.value}
          disabled={disabled || option.disabled}
          data-tip={option.title}
          className={cn(
            'inline-flex flex-1 items-center gap-1.5 whitespace-nowrap rounded-sm border-0 bg-transparent font-normal text-muted-foreground cursor-pointer',
            'transition-[background-color,color,box-shadow] touch-manipulation',
            'justify-center',
            'hover:not-data-disabled:not-data-checked:text-foreground',
            'data-checked:bg-thumb data-checked:font-medium data-checked:text-foreground data-checked:shadow-control',
            'focus-visible:outline-none focus-visible:shadow-focus',
            'data-disabled:pointer-events-none data-disabled:opacity-50',
            isSmall ? 'min-h-6 px-2.5 py-0.5 text-md' : 'min-h-7 px-3 py-1 text-md',
            '[@media(pointer:coarse)]:min-h-[30px]',
            option.className,
          )}
        >
          {option.icon !== undefined && option.icon !== null && (
            <span className="inline-flex items-center shrink-0 [&_svg]:size-3.5" aria-hidden="true">
              {option.icon}
            </span>
          )}
          {option.label !== undefined && option.label !== null && (
            <span className={cn('inline-flex items-center min-w-0', classNames?.label)}>
              {option.label}
            </span>
          )}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
