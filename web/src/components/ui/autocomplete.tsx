import * as React from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';
import { DropdownCaret } from '@/components/ui/dropdown-caret';

export interface AutoCompleteOption {
  value: string;
  label?: React.ReactNode;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface AutoCompleteProps {
  id?: string;
  value?: string;
  options?: AutoCompleteOption[];
  placeholder?: string;
  disabled?: boolean;
  status?: 'error' | 'warning';
  showCaret?: boolean;
  filterOption?: boolean | ((input: string, option?: AutoCompleteOption) => boolean);
  onChange?: (value: string) => void;
  onSelect?: (value: string, option: AutoCompleteOption) => void;
  className?: string;
  inputClassName?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  'data-testid'?: string;
  'data-alias-field'?: string;
}

export function AutoComplete({
  id,
  value = '',
  options = [],
  placeholder,
  disabled,
  status,
  showCaret = false,
  filterOption = true,
  onChange,
  onSelect,
  className,
  inputClassName,
  style,
  'aria-label': ariaLabel,
  'data-testid': testId,
  'data-alias-field': aliasField,
}: AutoCompleteProps) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed || filterOption === false) return options;
    if (typeof filterOption === 'function') {
      return options.filter((opt) => filterOption(value, opt));
    }
    const lower = trimmed.toLowerCase();
    return options.filter((opt) => {
      const labelStr = typeof opt.label === 'string' ? opt.label : opt.value;
      return labelStr.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower);
    });
  }, [filterOption, options, value]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length, open]);

  const showPopup = open && !disabled && filtered.length > 0;

  const commitOption = (opt: AutoCompleteOption) => {
    if (opt.disabled) return;
    onChange?.(opt.value);
    onSelect?.(opt.value, opt);
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root
      open={showPopup}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'outside-press' && anchorRef.current?.contains(details.event.target as Node)) {
          return;
        }
        setOpen(next);
      }}
    >
      <div
        ref={anchorRef}
        data-slot="autocomplete"
        data-popup-open={showPopup ? '' : undefined}
        style={style}
        className={cn(
          'group/autocomplete relative inline-flex h-8 w-full min-w-0 items-center rounded-md border-0 bg-field text-base text-foreground shadow-well transition-[background-color,box-shadow] hover:not-focus-within:bg-field-hover hover:not-focus-within:shadow-field-hover focus-within:shadow-field-focus [@media(pointer:coarse)]:min-h-10',
          disabled && 'cursor-not-allowed opacity-50',
          status === 'error' && 'shadow-field-invalid focus-within:shadow-field-invalid-focus',
          className,
        )}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPopup}
          aria-label={ariaLabel}
          data-testid={testId}
          data-alias-field={aliasField}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            if (!disabled && options.length > 0) setOpen(true);
          }}
          onClick={() => {
            if (!disabled && options.length > 0) setOpen(true);
          }}
          onChange={(e) => {
            onChange?.(e.target.value);
            if (!disabled) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              if (!showPopup && filtered.length > 0) {
                e.preventDefault();
                setOpen(true);
                return;
              }
              if (showPopup) {
                e.preventDefault();
                setActiveIndex((prev) => (prev + 1) % filtered.length);
              }
            } else if (e.key === 'ArrowUp' && showPopup) {
              e.preventDefault();
              setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
            } else if (e.key === 'Enter' && showPopup && filtered[activeIndex]) {
              e.preventDefault();
              commitOption(filtered[activeIndex]);
            } else if (e.key === 'Escape' && showPopup) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className={cn(
            'h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed',
            showCaret && 'pr-1',
            inputClassName,
          )}
        />
        {showCaret ? (
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-hidden="true"
            onMouseDown={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
              setOpen((prev) => !prev);
            }}
            className="inline-flex h-full cursor-pointer items-center border-0 bg-transparent pr-2.5 pl-1 text-muted-foreground"
          >
            <DropdownCaret className="group-data-[popup-open]/autocomplete:rotate-180 group-data-[popup-open]/autocomplete:text-foreground" />
          </button>
        ) : null}
      </div>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchorRef}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[1150] outline-none"
        >
          <PopoverPrimitive.Popup
            data-slot="combobox-content"
            initialFocus={false}
            finalFocus={false}
            style={{ width: 'var(--anchor-width)', maxWidth: 'calc(100vw - 24px)' }}
            className="omc-float-surface max-h-[min(260px,var(--available-height,260px))] overflow-y-auto overscroll-contain rounded-lg border-0 bg-popover p-1 text-popover-foreground shadow-float outline-none"
          >
            <div role="listbox" className="flex flex-col gap-0.5">
              {filtered.map((opt, idx) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  disabled={opt.disabled}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => commitOption(opt)}
                  className={cn(
                    'flex min-h-8 w-full cursor-pointer items-center truncate rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-base text-foreground outline-none transition-colors select-none [@media(pointer:coarse)]:min-h-10',
                    idx === activeIndex && 'bg-hover-inset',
                    opt.value === value && 'bg-selected font-medium',
                    opt.disabled && 'pointer-events-none opacity-45',
                  )}
                >
                  <span className="truncate">{opt.label ?? opt.value}</span>
                </button>
              ))}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
