import * as React from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Loader2, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownCaret } from '@/components/ui/dropdown-caret';

export type ComboboxValue = string | number;

export interface ComboboxOption {
  value?: ComboboxValue;
  label?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  searchText?: string;
  search?: string;
  options?: ComboboxOption[];
  [key: string]: unknown;
}

export interface ComboboxSearchConfig<OptionType extends ComboboxOption = ComboboxOption> {
  searchValue?: string;
  onSearch?: (value: string) => void;
  filterOption?: boolean | ((input: string, option?: OptionType) => boolean);
  optionFilterProp?: string | string[];
  autoClearSearchValue?: boolean;
}

export interface ComboboxProps<
  ValueType = ComboboxValue | ComboboxValue[],
  OptionType extends ComboboxOption = ComboboxOption,
> {
  id?: string;
  mode?: 'multiple' | 'tags';
  value?: ValueType;
  options?: OptionType[];
  placeholder?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  maxTagCount?: number | 'responsive';
  maxCount?: number;
  size?: 'sm' | 'default' | 'lg' | 'small' | 'middle' | 'large';
  status?: 'error' | 'warning';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showSearch?: boolean | ComboboxSearchConfig<OptionType>;
  tokenSeparators?: string[] | ((input: string) => string[]);
  virtual?: boolean;
  listHeight?: number;
  listItemHeight?: number;
  popupMatchSelectWidth?: boolean | number;
  suffixIcon?: React.ReactNode | null;
  notFoundContent?: React.ReactNode;
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  formatAddLabel?: (value: string) => React.ReactNode;
  labelRender?: (item: { value: ComboboxValue; label: React.ReactNode }) => React.ReactNode;
  optionRender?: (
    option: { key: string; label: React.ReactNode; value: ComboboxValue; data: OptionType },
    info: { index: number },
  ) => React.ReactNode;
  onChange?: (value: ValueType, option?: OptionType | OptionType[]) => void;
  onSelect?: (value: never, option: OptionType) => void;
  onDeselect?: (value: never, option: OptionType) => void;
  className?: string;
  classNames?: { popup?: { root?: string } };
  popupClassName?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

type FlatRow<OptionType extends ComboboxOption> =
  | { kind: 'group'; key: string; label: React.ReactNode }
  | { kind: 'add'; key: string; text: string }
  | { kind: 'option'; key: string; option: OptionType; optionIndex: number };

function splitTokens(input: string, separators?: string[] | ((raw: string) => string[])): string[] {
  if (!separators) return [input];
  if (typeof separators === 'function') return separators(input);
  if (separators.length === 0) return [input];
  return separators.reduce<string[]>((acc, sep) => acc.flatMap((part) => part.split(sep)), [input]);
}

function normalizeTriggerSize(size?: ComboboxProps['size']): 'sm' | 'default' | 'lg' {
  if (size === 'sm' || size === 'small') return 'sm';
  if (size === 'lg' || size === 'large') return 'lg';
  return 'default';
}

export function Combobox<
  ValueType = ComboboxValue | ComboboxValue[],
  OptionType extends ComboboxOption = ComboboxOption,
>({
  id,
  mode,
  value,
  options = [],
  placeholder,
  disabled,
  loading,
  allowClear,
  maxTagCount,
  maxCount,
  size,
  status,
  open: controlledOpen,
  onOpenChange,
  showSearch,
  tokenSeparators,
  virtual,
  listHeight = 300,
  listItemHeight = 36,
  popupMatchSelectWidth = true,
  suffixIcon,
  notFoundContent,
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  formatAddLabel,
  labelRender,
  optionRender,
  onChange,
  onSelect,
  onDeselect,
  className,
  classNames,
  popupClassName,
  style,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: ComboboxProps<ValueType, OptionType>) {
  const isMultiple = mode === 'multiple' || mode === 'tags';
  const isPopupDisabled = controlledOpen === false;
  const searchCfg: ComboboxSearchConfig<OptionType> =
    typeof showSearch === 'object' ? showSearch : {};
  const isSearchable = showSearch ?? true;

  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;

  const [ownQuery, setOwnQuery] = React.useState('');
  const query = searchCfg.searchValue ?? ownQuery;
  const setQuery = React.useCallback(
    (next: string) => {
      setOwnQuery(next);
      searchCfg.onSearch?.(next);
    },
    [searchCfg],
  );

  const [activeIndex, setActiveIndex] = React.useState<number>(0);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const inlineInputRef = React.useRef<HTMLInputElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const listScrollFocusRef = React.useRef<HTMLDivElement | null>(null);

  const attachScrollEl = React.useCallback((node: HTMLDivElement | null) => {
    listScrollFocusRef.current = node;
    setScrollEl(node);
  }, []);

  const selected = React.useMemo<ComboboxValue[]>(() => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value as ComboboxValue[];
    if ((value as unknown) === '') return [];
    return [value as unknown as ComboboxValue];
  }, [value]);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (disabled) return;
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
      if (!next && searchCfg.searchValue === undefined) {
        setOwnQuery('');
      }
    },
    [controlledOpen, disabled, onOpenChange, searchCfg.searchValue],
  );

  const optionGroups = React.useMemo(() => {
    const baseGroups: { label?: React.ReactNode; options: OptionType[] }[] = options.some((opt) =>
      Array.isArray(opt.options),
    )
      ? options.map((opt) =>
          Array.isArray(opt.options)
            ? { label: opt.label, options: opt.options as OptionType[] }
            : { options: [opt] },
        )
      : [{ options }];

    if (mode !== 'tags') return baseGroups;
    const known = new Set<ComboboxValue>();
    for (const g of baseGroups) {
      for (const opt of g.options) {
        if (opt.value !== undefined) known.add(opt.value);
      }
    }
    const extra = selected
      .filter((entry) => !known.has(entry))
      .map((entry) => ({ value: entry, label: String(entry) }) as OptionType);
    if (extra.length === 0) return baseGroups;
    const [first, ...rest] = baseGroups;
    return first ? [{ ...first, options: [...extra, ...first.options] }, ...rest] : [{ options: extra }];
  }, [mode, options, selected]);

  const allListedOptions = React.useMemo(
    () => optionGroups.flatMap((g) => g.options),
    [optionGroups],
  );

  const byValue = React.useMemo(() => {
    const map = new Map<ComboboxValue, OptionType>();
    for (const opt of allListedOptions) {
      if (opt.value !== undefined) map.set(opt.value, opt);
    }
    return map;
  }, [allListedOptions]);

  const matchesQuery = React.useCallback(
    (option: OptionType) => {
      const trimmed = query.trim();
      if (!trimmed || searchCfg.filterOption === false) return true;
      if (typeof searchCfg.filterOption === 'function') return searchCfg.filterOption(query, option);
      const lower = trimmed.toLowerCase();
      const propsToCheck = searchCfg.optionFilterProp
        ? [searchCfg.optionFilterProp].flat()
        : ['label', 'value', 'title', 'searchText', 'search'];
      return propsToCheck.some((prop) => {
        const raw = option[prop];
        if (typeof raw === 'string' || typeof raw === 'number') {
          return String(raw).toLowerCase().includes(lower);
        }
        return false;
      });
    },
    [query, searchCfg],
  );

  const typed = query.trim();
  const isFull = maxCount !== undefined && selected.length >= maxCount;
  const canAddTag =
    mode === 'tags' &&
    typed !== '' &&
    !isFull &&
    !allListedOptions.some((opt) => String(opt.value) === typed);

  const flatRows = React.useMemo<FlatRow<OptionType>[]>(() => {
    const rows: FlatRow<OptionType>[] = [];
    if (canAddTag) {
      rows.push({ kind: 'add', key: `__add__:${typed}`, text: typed });
    }
    let idx = 0;
    optionGroups.forEach((group, groupIdx) => {
      const filtered = group.options.filter(matchesQuery);
      if (filtered.length === 0) return;
      if (group.label !== undefined && group.label !== null) {
        rows.push({ kind: 'group', key: `__grp__:${groupIdx}`, label: group.label });
      }
      for (const opt of filtered) {
        rows.push({
          kind: 'option',
          key: `opt:${String(opt.value ?? idx)}`,
          option: opt,
          optionIndex: idx,
        });
        idx += 1;
      }
    });
    return rows;
  }, [canAddTag, matchesQuery, optionGroups, typed]);

  React.useEffect(() => {
    const firstSelectable = flatRows.findIndex((r) => r.kind !== 'group');
    setActiveIndex(firstSelectable >= 0 ? firstSelectable : 0);
  }, [query, isOpen, flatRows.length]);

  const commitTagsFromText = React.useCallback(
    (rawText: string) => {
      const parts = splitTokens(rawText, tokenSeparators);
      const added = [
        ...new Set(
          parts.map((p) => p.trim()).filter((p) => p !== '' && !selected.includes(p)),
        ),
      ];
      if (added.length === 0) {
        setQuery('');
        return;
      }
      const room = maxCount === undefined ? Infinity : Math.max(0, maxCount - selected.length);
      const next = [...selected, ...added.slice(0, room)];
      onChange?.(
        next as unknown as ValueType,
        next.map((entry) => byValue.get(entry) ?? ({ value: entry, label: String(entry) } as OptionType)),
      );
      setQuery('');
    },
    [byValue, maxCount, onChange, selected, setQuery, tokenSeparators],
  );

  const removeSelectedValue = React.useCallback(
    (val: ComboboxValue) => {
      if (disabled) return;
      const next = selected.filter((entry) => entry !== val);
      const removedOpt = byValue.get(val) ?? ({ value: val, label: String(val) } as OptionType);
      onChange?.(
        next as unknown as ValueType,
        next.map((entry) => byValue.get(entry) ?? ({ value: entry, label: String(entry) } as OptionType)),
      );
      onDeselect?.(val as never, removedOpt);
    },
    [byValue, disabled, onChange, onDeselect, selected],
  );

  const pickOption = React.useCallback(
    (option: OptionType) => {
      const picked = option.value;
      if (picked === undefined || option.disabled) return;
      if (!isMultiple) {
        onChange?.(picked as unknown as ValueType, option);
        onSelect?.(picked as never, option);
        setOpen(false);
        return;
      }
      const exists = selected.includes(picked);
      if (!exists && isFull) return;
      const next = exists ? selected.filter((entry) => entry !== picked) : [...selected, picked];
      onChange?.(
        next as unknown as ValueType,
        next.map((entry) => byValue.get(entry) ?? ({ value: entry, label: String(entry) } as OptionType)),
      );
      if (exists) {
        onDeselect?.(picked as never, option);
      } else {
        onSelect?.(picked as never, option);
        if (searchCfg.autoClearSearchValue !== false) setQuery('');
      }
    },
    [byValue, isFull, isMultiple, onChange, onDeselect, onSelect, searchCfg.autoClearSearchValue, selected, setOpen, setQuery],
  );

  const clearAll = React.useCallback(() => {
    if (disabled) return;
    if (isMultiple) {
      onChange?.([] as unknown as ValueType, []);
    } else {
      (onChange as ((val: undefined, opt?: undefined) => void) | undefined)?.(undefined, undefined);
    }
  }, [disabled, isMultiple, onChange]);

  const useVirtual = Boolean(virtual) || flatRows.length > 80;
  const rowVirtualizer = useVirtualizer({
    count: useVirtual ? flatRows.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: (index) => (flatRows[index]?.kind === 'group' ? 28 : listItemHeight),
    overscan: 8,
  });

  const stepActive = (delta: 1 | -1) => {
    if (flatRows.length === 0) return;
    let next = activeIndex;
    for (let i = 0; i < flatRows.length; i += 1) {
      next = (next + delta + flatRows.length) % flatRows.length;
      const row = flatRows[next];
      if (row.kind === 'add') {
        setActiveIndex(next);
        if (useVirtual) rowVirtualizer.scrollToIndex(next, { align: 'auto' });
        return;
      }
      if (row.kind === 'option' && !row.option.disabled) {
        setActiveIndex(next);
        if (useVirtual) rowVirtualizer.scrollToIndex(next, { align: 'auto' });
        return;
      }
    }
  };

  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (rowIndex: number) => `${baseId}-opt-${rowIndex}`;
  const activeRow = isOpen && !isPopupDisabled ? flatRows[activeIndex] : undefined;
  const activeOptionId =
    activeRow &&
    (activeRow.kind === 'add' || (activeRow.kind === 'option' && !activeRow.option.disabled))
      ? optionId(activeIndex)
      : undefined;

  const isImeComposing = (e: React.KeyboardEvent) =>
    Boolean(e.nativeEvent.isComposing) || e.keyCode === 229;

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepActive(-1);
    } else if (e.key === 'Enter') {
      const row = flatRows[activeIndex];
      if (row?.kind === 'add') {
        e.preventDefault();
        commitTagsFromText(row.text);
      } else if (row?.kind === 'option' && !row.option.disabled) {
        e.preventDefault();
        pickOption(row.option);
      } else if (mode === 'tags' && typed !== '') {
        e.preventDefault();
        commitTagsFromText(typed);
      }
    } else if (e.key === 'Backspace' && query === '' && isMultiple && selected.length > 0) {
      removeSelectedValue(selected[selected.length - 1]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const resolvedSize = normalizeTriggerSize(size);
  const maxVisibleTags =
    maxTagCount === 'responsive' ? 2 : typeof maxTagCount === 'number' ? maxTagCount : Infinity;
  const visibleTags = isMultiple ? selected.slice(0, maxVisibleTags) : [];
  const overflowCount = isMultiple ? Math.max(0, selected.length - visibleTags.length) : 0;

  const renderSingleDisplay = () => {
    if (selected.length === 0) {
      return placeholder ? <span className="truncate text-muted-foreground">{placeholder}</span> : null;
    }
    const current = selected[0];
    const opt = byValue.get(current);
    const fallbackLabel = opt?.label ?? String(current);
    return (
      <span className="min-w-0 flex-1 truncate text-left">
        {labelRender ? labelRender({ value: current, label: fallbackLabel }) : fallbackLabel}
      </span>
    );
  };

  const renderChipLabel = (val: ComboboxValue) => {
    const opt = byValue.get(val);
    const fallbackLabel = opt?.label ?? String(val);
    return labelRender ? labelRender({ value: val, label: fallbackLabel }) : fallbackLabel;
  };

  if (isPopupDisabled && mode === 'tags') {
    return (
      <div
        data-slot="combobox-inline-tags"
        data-testid={testId}
        style={style}
        onClick={() => inlineInputRef.current?.focus()}
        className={cn(
          'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border-0 bg-field px-2 py-1 text-base text-foreground shadow-well transition-[background-color,box-shadow] hover:not-focus-within:bg-field-hover hover:not-focus-within:shadow-field-hover focus-within:shadow-field-focus',
          disabled && 'cursor-not-allowed opacity-50',
          status === 'error' && 'shadow-field-invalid focus-within:shadow-field-invalid-focus',
          className,
        )}
      >
        {selected.map((val) => (
          <span
            key={String(val)}
            className="inline-flex max-w-full items-center gap-1 rounded-sm bg-selected px-1.5 py-0.5 text-xs text-foreground"
          >
            <span className="truncate">{renderChipLabel(val)}</span>
            {!disabled ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove ${String(val)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeSelectedValue(val);
                }}
                className="inline-flex size-3.5 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
              </button>
            ) : null}
          </span>
        ))}
        <input
          ref={inlineInputRef}
          id={id}
          type="text"
          disabled={disabled}
          value={query}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          placeholder={selected.length === 0 && typeof placeholder === 'string' ? placeholder : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            const composing = Boolean((e.nativeEvent as InputEvent).isComposing);
            if (!composing && tokenSeparators && Array.isArray(tokenSeparators) && tokenSeparators.some((sep) => raw.includes(sep))) {
              commitTagsFromText(raw);
              return;
            }
            setQuery(raw);
          }}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === 'Enter' && query.trim() !== '') {
              e.preventDefault();
              commitTagsFromText(query);
            } else if (e.key === 'Backspace' && query === '' && selected.length > 0) {
              removeSelectedValue(selected[selected.length - 1]);
            }
          }}
          onBlur={() => {
            if (query.trim() !== '') commitTagsFromText(query);
          }}
          className="min-w-[80px] flex-1 border-0 bg-transparent py-0.5 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
    );
  }

  const widthStyle: React.CSSProperties =
    typeof popupMatchSelectWidth === 'number'
      ? { width: `min(${popupMatchSelectWidth}px, calc(100vw - 24px))` }
      : popupMatchSelectWidth
        ? { width: 'var(--anchor-width)', maxWidth: 'calc(100vw - 24px)' }
        : { minWidth: 'max(var(--anchor-width), 220px)', maxWidth: 'min(480px, calc(100vw - 24px))' };

  const renderRow = (row: FlatRow<OptionType>, rowIndex: number, rowStyle?: React.CSSProperties, measureRef?: (node: Element | null) => void, dataIndex?: number) => {
    if (row.kind === 'group') {
      return (
        <div
          key={row.key}
          ref={measureRef}
          data-index={dataIndex}
          style={rowStyle}
          role="presentation"
          className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none"
        >
          {row.label}
        </div>
      );
    }
    if (row.kind === 'add') {
      const isHighlighted = rowIndex === activeIndex;
      return (
        <button
          key={row.key}
          id={optionId(rowIndex)}
          ref={measureRef}
          data-index={dataIndex}
          type="button"
          role="option"
          aria-selected={false}
          style={rowStyle}
          onMouseEnter={() => setActiveIndex(rowIndex)}
          onClick={() => commitTagsFromText(row.text)}
          className={cn(
            'flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-base text-foreground outline-none transition-colors select-none [@media(pointer:coarse)]:min-h-10',
            isHighlighted && 'bg-hover-inset',
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {formatAddLabel ? formatAddLabel(row.text) : `+ "${row.text}"`}
          </span>
          <Plus className="size-3.5 shrink-0 text-brand" />
        </button>
      );
    }
    const { option, optionIndex } = row;
    const isSelected = option.value !== undefined && selected.includes(option.value);
    const isOptionDisabled = Boolean(option.disabled) || (isFull && !isSelected);
    const isHighlighted = rowIndex === activeIndex;
    const content = optionRender
      ? optionRender(
          {
            key: String(option.value ?? optionIndex),
            label: option.label,
            value: option.value as ComboboxValue,
            data: option,
          },
          { index: optionIndex },
        )
      : (option.label ?? String(option.value ?? ''));

    return (
      <button
        key={row.key}
        id={optionId(rowIndex)}
        ref={measureRef}
        data-index={dataIndex}
        type="button"
        role="option"
        aria-selected={isSelected}
        disabled={isOptionDisabled}
        style={rowStyle}
        onMouseEnter={() => setActiveIndex(rowIndex)}
        onClick={() => pickOption(option)}
        className={cn(
          'flex min-h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-base text-foreground outline-none transition-colors select-none [@media(pointer:coarse)]:min-h-10',
          isHighlighted && 'bg-hover-inset',
          isSelected && 'bg-selected font-medium',
          isOptionDisabled && 'pointer-events-none opacity-45',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{content}</span>
        {isSelected ? <Check className="size-3.5 shrink-0 text-brand" /> : null}
      </button>
    );
  };

  return (
    <PopoverPrimitive.Root
      open={isPopupDisabled ? false : isOpen}
      onOpenChange={(next) => {
        if (isPopupDisabled) {
          if (next) onOpenChange?.(true);
          return;
        }
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger
        nativeButton={false}
        render={(triggerProps) => (
          <div
            {...triggerProps}
            ref={(node) => {
              triggerRef.current = node;
              const extRef = (triggerProps as { ref?: React.Ref<HTMLDivElement> }).ref;
              if (typeof extRef === 'function') extRef(node);
              else if (extRef && 'current' in extRef) {
                (extRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
              }
            }}
            id={id}
            role="combobox"
            tabIndex={disabled ? -1 : 0}
            aria-expanded={isPopupDisabled ? false : isOpen}
            aria-controls={!isPopupDisabled && isOpen ? listboxId : undefined}
            aria-haspopup="listbox"
            aria-disabled={disabled || undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-slot="combobox-trigger"
            data-size={resolvedSize}
            data-status={status}
            data-popup-open={isOpen && !isPopupDisabled ? '' : undefined}
            data-testid={testId}
            style={style}
            onMouseDown={(e) => {
              (triggerProps.onMouseDown as React.MouseEventHandler<HTMLDivElement> | undefined)?.(e);
              if (disabled || e.button !== 0) return;
              if (isPopupDisabled) {
                e.preventDefault();
                onOpenChange?.(true);
              }
            }}
            onKeyDown={(e) => {
              (triggerProps.onKeyDown as React.KeyboardEventHandler<HTMLDivElement> | undefined)?.(e);
              if (disabled) return;
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (isPopupDisabled) onOpenChange?.(true);
                else setOpen(true);
              }
            }}
            className={cn(
              'group/combobox inline-flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-field text-base text-foreground shadow-well outline-none transition-[background-color,box-shadow,color] select-none',
              'hover:not-data-[popup-open]:bg-field-hover hover:not-data-[popup-open]:shadow-field-hover focus-visible:shadow-field-focus data-[popup-open]:shadow-field-focus',
              disabled && 'pointer-events-none cursor-not-allowed opacity-50',
              status === 'error' && 'shadow-field-invalid focus-visible:shadow-field-invalid-focus',
              status === 'warning' && 'shadow-[inset_0_0_0_1px_var(--warn)]',
              !isMultiple && resolvedSize === 'sm' && 'h-7 pl-2.5 pr-2 text-md [@media(pointer:coarse)]:min-h-9',
              !isMultiple && resolvedSize === 'default' && 'h-8 pl-3 pr-2.5 text-base [@media(pointer:coarse)]:min-h-10',
              !isMultiple && resolvedSize === 'lg' && 'h-10 pl-3.5 pr-3 text-base',
              isMultiple && 'min-h-8 py-1 pl-2 pr-2.5 [@media(pointer:coarse)]:min-h-10',
              className,
            )}
          >
            {isMultiple ? (
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {selected.length === 0 ? (
                  placeholder ? (
                    <span className="truncate pl-1 text-muted-foreground">{placeholder}</span>
                  ) : null
                ) : (
                  <>
                    {visibleTags.map((val) => (
                      <span
                        key={String(val)}
                        className="inline-flex max-w-[180px] items-center gap-1 rounded-sm bg-selected px-1.5 py-0.5 text-xs text-foreground"
                      >
                        <span className="truncate">{renderChipLabel(val)}</span>
                        {!disabled ? (
                          <span
                            role="button"
                            tabIndex={-1}
                            aria-label={`Remove ${String(val)}`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              removeSelectedValue(val);
                            }}
                            className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-2.5" />
                          </span>
                        ) : null}
                      </span>
                    ))}
                    {overflowCount > 0 ? (
                      <span className="inline-flex items-center rounded-sm bg-selected px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                        +{overflowCount}
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            ) : (
              renderSingleDisplay()
            )}
            <span className="inline-flex shrink-0 items-center gap-1">
              {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
              {allowClear && selected.length > 0 && !disabled ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Clear"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearAll();
                  }}
                  className="inline-flex size-4 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-hover-inset hover:text-foreground"
                >
                  <X className="size-3" />
                </span>
              ) : null}
              {suffixIcon !== null ? (
                suffixIcon ?? (
                  <DropdownCaret className="group-data-[popup-open]/combobox:rotate-180 group-data-[popup-open]/combobox:text-foreground" />
                )
              ) : null}
            </span>
          </div>
        )}
      />

      {!isPopupDisabled ? (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-[1150] outline-none"
          >
            <PopoverPrimitive.Popup
              data-slot="combobox-content"
              initialFocus={isSearchable ? searchInputRef : listScrollFocusRef}
              style={widthStyle}
              className={cn(
                'omc-float-surface flex flex-col overflow-hidden rounded-lg border-0 bg-popover text-popover-foreground shadow-float outline-none',
                classNames?.popup?.root,
                popupClassName,
              )}
            >
              {isSearchable ? (
                <div className="flex items-center gap-2 border-b-[length:var(--hairline)] border-b-border-soft px-3 py-2">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={isOpen}
                    aria-controls={listboxId}
                    aria-activedescendant={activeOptionId}
                    value={query}
                    placeholder={searchPlaceholder}
                    aria-label={ariaLabel ? `${ariaLabel} search` : searchPlaceholder}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const composing = Boolean((e.nativeEvent as InputEvent).isComposing);
                      if (
                        !composing &&
                        mode === 'tags' &&
                        tokenSeparators &&
                        Array.isArray(tokenSeparators) &&
                        tokenSeparators.some((sep) => raw.includes(sep))
                      ) {
                        commitTagsFromText(raw);
                        return;
                      }
                      setQuery(raw);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    className="h-6 min-w-0 flex-1 border-0 bg-transparent p-0 text-base text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {query ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Clear search"
                      onClick={() => setQuery('')}
                      className="inline-flex size-4 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div
                id={listboxId}
                ref={attachScrollEl}
                role="listbox"
                tabIndex={!isSearchable ? -1 : undefined}
                aria-activedescendant={!isSearchable ? activeOptionId : undefined}
                onKeyDown={!isSearchable ? (handleSearchKeyDown as unknown as React.KeyboardEventHandler<HTMLDivElement>) : undefined}
                aria-label={ariaLabel}
                aria-multiselectable={isMultiple || undefined}
                style={{ maxHeight: `min(${listHeight}px, var(--available-height, ${listHeight}px))` }}
                className="overflow-y-auto overscroll-contain p-1 outline-none"
              >
                {flatRows.length === 0 ? (
                  <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                    {notFoundContent ?? emptyText}
                  </div>
                ) : useVirtual ? (
                  <div
                    style={{
                      height: `${rowVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {rowVirtualizer.getVirtualItems().map((vItem) =>
                      renderRow(
                        flatRows[vItem.index],
                        vItem.index,
                        {
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${vItem.start}px)`,
                        },
                        rowVirtualizer.measureElement,
                        vItem.index,
                      ),
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {flatRows.map((row, idx) => renderRow(row, idx))}
                  </div>
                )}
              </div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      ) : null}
    </PopoverPrimitive.Root>
  );
}
