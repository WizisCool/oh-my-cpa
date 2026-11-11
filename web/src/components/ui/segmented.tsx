import * as React from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';
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

  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<T | undefined>(() => defaultValue ?? normalized[0]?.value);
  const current = isControlled ? value : internal;
  const encodedValue = current !== undefined ? [String(current)] : [];

  const handleValueChange = (nextValues: string[]) => {
    // Segmented controls always keep one active segment; clicking the active segment is a no-op.
    if (nextValues.length === 0) return;
    const picked = nextValues[nextValues.length - 1];
    const match = normalized.find((opt) => String(opt.value) === picked);
    if (!match) return;
    if (!isControlled) setInternal(match.value);
    onChange?.(match.value);
  };

  const resolvedSize = size === 'sm' || size === 'small' ? 'sm' : 'default';

  return (
    <ToggleGroup
      id={id}
      data-slot="segmented"
      size={resolvedSize}
      block={block}
      disabled={disabled}
      orientation={vertical ? 'vertical' : 'horizontal'}
      value={encodedValue}
      onValueChange={handleValueChange}
      style={style}
      className={cn(vertical && 'items-stretch', className)}
      {...ariaProps}
    >
      {normalized.map((option) => {
        const key = String(option.value);
        return (
          <ToggleGroupItem
            key={key}
            data-slot="segmented-item"
            value={key}
            disabled={disabled || option.disabled}
            title={option.title}
            className={cn(vertical && 'justify-start text-left', option.className)}
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
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
