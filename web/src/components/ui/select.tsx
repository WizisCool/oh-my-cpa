import * as React from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownCaret } from '@/components/ui/dropdown-caret';

const SelectRoot = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('p-0.5', className)} {...props} />;
}

function SelectGroupLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn('px-2.5 py-1.5 text-xs font-medium text-muted-foreground select-none', className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('min-w-0 flex-1 truncate text-left data-[placeholder]:text-muted-foreground', className)}
      {...props}
    />
  );
}

interface SelectTriggerProps extends Omit<SelectPrimitive.Trigger.Props, 'prefix'> {
  size?: 'sm' | 'default' | 'lg';
  variant?: 'filled' | 'borderless';
  status?: 'error' | 'warning';
  prefix?: React.ReactNode;
  loading?: boolean;
  hideCaret?: boolean;
  onClear?: () => void;
  clearLabel?: string;
}

function SelectTrigger({
  className,
  size = 'default',
  variant = 'filled',
  status,
  prefix,
  loading = false,
  hideCaret = false,
  onClear,
  clearLabel,
  children,
  disabled,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-variant={variant}
      data-status={status}
      disabled={disabled}
      className={cn(
        'group/select inline-flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border-0 text-base text-foreground outline-none transition-[background-color,box-shadow,color] select-none',
        variant === 'borderless'
          ? 'bg-transparent shadow-none hover:enabled:bg-hover-inset focus-visible:shadow-field-focus'
          : 'bg-field shadow-well hover:enabled:not-data-[popup-open]:bg-field-hover hover:enabled:not-data-[popup-open]:shadow-field-hover focus-visible:shadow-field-focus data-[popup-open]:shadow-field-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
        status === 'error' && 'shadow-field-invalid focus-visible:shadow-field-invalid-focus data-[popup-open]:shadow-field-invalid-focus',
        status === 'warning' && 'shadow-[inset_0_0_0_1px_var(--warn)]',
        size === 'sm' && 'h-7 pl-2.5 pr-2 text-md [@media(pointer:coarse)]:min-h-9',
        size === 'default' && 'h-8 pl-3 pr-2.5 text-base [@media(pointer:coarse)]:min-h-10',
        size === 'lg' && 'h-10 pl-3.5 pr-3 text-base',
        className,
      )}
      {...props}
    >
      {prefix ? <span className="inline-flex shrink-0 items-center text-muted-foreground">{prefix}</span> : null}
      {children}
      <span className="inline-flex shrink-0 items-center gap-1">
        {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        {onClear && !disabled ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={clearLabel ?? 'Clear'}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClear();
            }}
            className="inline-flex size-4 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-hover-inset hover:text-foreground"
          >
            <X className="size-3" />
          </span>
        ) : null}
        {!hideCaret ? (
          <SelectPrimitive.Icon data-slot="select-icon" className="inline-flex items-center">
            <DropdownCaret className="group-data-[popup-open]/select:rotate-180 group-data-[popup-open]/select:text-foreground" />
          </SelectPrimitive.Icon>
        ) : null}
      </span>
    </SelectPrimitive.Trigger>
  );
}

interface SelectContentProps extends SelectPrimitive.Popup.Props {
  side?: SelectPrimitive.Positioner.Props['side'];
  sideOffset?: SelectPrimitive.Positioner.Props['sideOffset'];
  align?: SelectPrimitive.Positioner.Props['align'];
  alignOffset?: SelectPrimitive.Positioner.Props['alignOffset'];
  alignItemWithTrigger?: boolean;
  matchTriggerWidth?: boolean | number;
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  alignItemWithTrigger = false,
  matchTriggerWidth = true,
  style,
  ...props
}: SelectContentProps) {
  const widthStyle: React.CSSProperties =
    typeof matchTriggerWidth === 'number'
      ? { width: `min(${matchTriggerWidth}px, calc(100vw - 24px))` }
      : matchTriggerWidth
        ? { minWidth: 'var(--anchor-width)', maxWidth: 'min(480px, calc(100vw - 24px))' }
        : { minWidth: 'max(var(--anchor-width), 160px)', maxWidth: 'min(480px, calc(100vw - 24px))' };

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        collisionPadding={12}
        className="z-[1150] outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          style={{ ...widthStyle, ...style }}
          className={cn(
            'omc-float-surface max-h-[min(320px,var(--available-height,320px))] overflow-y-auto overflow-x-hidden rounded-lg border-0 bg-popover p-1 text-popover-foreground shadow-float outline-none',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List data-slot="select-list" className="flex flex-col gap-0.5 outline-none">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, onClickCapture, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      onClickCapture={(e) => {
        if ((e.nativeEvent as PointerEvent).pointerType === undefined) {
          Object.defineProperty(e.nativeEvent, 'pointerType', { value: '', configurable: true });
        }
        onClickCapture?.(e);
      }}
      className={cn(
        'relative flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-base text-foreground outline-none transition-colors select-none [@media(pointer:coarse)]:min-h-10',
        'data-[highlighted]:bg-hover-inset data-[selected]:bg-selected data-[selected]:font-medium',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText data-slot="select-item-text" className="min-w-0 flex-1 truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator data-slot="select-item-indicator" className="inline-flex shrink-0 items-center text-brand">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('my-1 h-[var(--hairline)] bg-border-soft', className)}
      {...props}
    />
  );
}

export type SelectPrimitiveValue = string | number | boolean;

export interface SelectOptionItem<V extends SelectPrimitiveValue = string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
  searchText?: string;
  [key: string]: unknown;
}

export interface SelectOptionGroup<V extends SelectPrimitiveValue = string> {
  label: React.ReactNode;
  options: SelectOptionItem<V>[];
}

export type SelectEntry<V extends SelectPrimitiveValue = string> =
  | SelectOptionItem<V>
  | SelectOptionGroup<V>;

function isOptionGroup<V extends SelectPrimitiveValue>(
  entry: SelectEntry<V>,
): entry is SelectOptionGroup<V> {
  return 'options' in entry && Array.isArray(entry.options);
}

export interface SimpleSelectProps<V extends SelectPrimitiveValue = string> {
  id?: string;
  value?: V | null;
  defaultValue?: V;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: (value: any, option?: SelectOptionItem<V>) => void;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  options?: readonly SelectEntry<V>[];
  placeholder?: React.ReactNode;
  prefix?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  size?: 'sm' | 'default' | 'lg' | 'small' | 'middle' | 'large';
  variant?: 'filled' | 'borderless';
  status?: 'error' | 'warning';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  popupMatchSelectWidth?: boolean | number;
  suffixIcon?: React.ReactNode | null;
  labelRender?: (item: { value: V; label: React.ReactNode }) => React.ReactNode;
  optionRender?: (option: { data: SelectOptionItem<V>; value: V; label: React.ReactNode }) => React.ReactNode;
  notFoundContent?: React.ReactNode;
  className?: string;
  popupClassName?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}

function flattenEntries<V extends SelectPrimitiveValue>(
  entries: readonly SelectEntry<V>[],
): SelectOptionItem<V>[] {
  const flat: SelectOptionItem<V>[] = [];
  for (const entry of entries) {
    if (isOptionGroup(entry)) {
      flat.push(...entry.options);
    } else {
      flat.push(entry);
    }
  }
  return flat;
}

function normalizeSize(size?: SimpleSelectProps['size']): 'sm' | 'default' | 'lg' {
  if (size === 'sm' || size === 'small') return 'sm';
  if (size === 'lg' || size === 'large') return 'lg';
  return 'default';
}

function Select<V extends SelectPrimitiveValue = string>({
  id,
  value,
  defaultValue,
  onChange,
  onBlur,
  options = [],
  placeholder,
  prefix,
  disabled,
  loading,
  allowClear,
  size,
  variant = 'filled',
  status,
  open,
  onOpenChange,
  popupMatchSelectWidth = true,
  suffixIcon,
  labelRender,
  optionRender,
  notFoundContent,
  className,
  popupClassName,
  style,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'data-testid': testId,
}: SimpleSelectProps<V>) {
  const flat = React.useMemo(() => flattenEntries(options), [options]);
  const optionMap = React.useMemo(() => {
    const map = new Map<V, SelectOptionItem<V>>();
    for (const item of flat) map.set(item.value, item);
    return map;
  }, [flat]);

  const controlled = value !== undefined;
  const normalizedValue = controlled ? (value ?? null) : undefined;
  const hasValue =
    controlled && value !== null && value !== undefined && (value as unknown) !== '';

  const renderItem = (opt: SelectOptionItem<V>) => (
    <SelectItem key={String(opt.value)} value={opt.value} disabled={opt.disabled}>
      {optionRender ? optionRender({ data: opt, value: opt.value, label: opt.label }) : opt.label}
    </SelectItem>
  );

  return (
    <SelectRoot<V>
      id={id}
      value={normalizedValue as V}
      defaultValue={defaultValue}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => onOpenChange?.(next)}
      onValueChange={(next) => {
        if (next === null || next === undefined) {
          if (allowClear) onChange?.(undefined);
          return;
        }
        onChange?.(next, optionMap.get(next));
      }}
    >
      <SelectTrigger
        size={normalizeSize(size)}
        variant={variant}
        status={status}
        prefix={prefix}
        loading={loading}
        hideCaret={suffixIcon === null}
        onBlur={onBlur}
        onClear={allowClear && hasValue ? () => onChange?.(undefined) : undefined}
        className={className}
        style={style}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-testid={testId}
      >
        <SelectValue placeholder={placeholder}>
          {(current: V | null) => {
            if (current === null || current === undefined || (current as unknown) === '') {
              const emptyOpt = optionMap.get('' as V);
              if (current === ('' as V) && emptyOpt) {
                return labelRender ? labelRender({ value: current, label: emptyOpt.label }) : emptyOpt.label;
              }
              return placeholder ? <span className="text-muted-foreground">{placeholder}</span> : null;
            }
            const found = optionMap.get(current);
            const resolvedLabel = found ? found.label : String(current);
            return labelRender ? labelRender({ value: current, label: resolvedLabel }) : resolvedLabel;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent matchTriggerWidth={popupMatchSelectWidth} className={popupClassName}>
        {flat.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">{notFoundContent ?? '—'}</div>
        ) : (
          options.map((entry, idx) =>
            isOptionGroup(entry) ? (
              <SelectGroup key={idx}>
                <SelectGroupLabel>{entry.label}</SelectGroupLabel>
                {entry.options.map(renderItem)}
              </SelectGroup>
            ) : (
              renderItem(entry)
            ),
          )
        )}
      </SelectContent>
    </SelectRoot>
  );
}

export type SelectProps<V extends SelectPrimitiveValue = string> = SimpleSelectProps<V>;

export {
  Select,
  SelectRoot,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
