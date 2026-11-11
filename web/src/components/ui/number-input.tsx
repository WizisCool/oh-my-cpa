import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWheelStep } from '@/hooks/useWheelStep';

export interface NumberInputProps<T extends number | string = number>
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'size' | 'prefix' | 'min' | 'max' | 'step'> {
  value?: T | null;
  defaultValue?: T | null;
  onChange?: (value: T | null) => void;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  precision?: number;
  stringMode?: boolean;
  controls?: boolean;
  keyboard?: boolean;
  size?: 'default' | 'sm' | 'small' | 'middle' | 'large';
  status?: 'error' | 'warning';
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  addonAfter?: React.ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}

function decimalsOf(value: number | string): number {
  const text = String(value);
  const expIndex = text.toLowerCase().indexOf('e-');
  if (expIndex !== -1) return Number(text.slice(expIndex + 2)) || 0;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function toFiniteNumber(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampAndRound(value: number, min?: number, max?: number, precision?: number, stepScale = 0): number {
  let next = value;
  if (min !== undefined && next < min) next = min;
  if (max !== undefined && next > max) next = max;
  const places = precision ?? stepScale;
  if (places >= 0 && places <= 20) {
    next = Number(next.toFixed(places));
  }
  return Object.is(next, -0) ? 0 : next;
}

function formatDisplay<T extends number | string>(val: T | null | undefined, precision?: number, stringMode?: boolean): string {
  if (val === null || val === undefined) return '';
  if (stringMode || typeof val === 'string') return String(val);
  if (!Number.isFinite(val)) return '';
  return precision !== undefined ? val.toFixed(precision) : String(val);
}

function NumberInputInner<T extends number | string = number>(
  {
    value,
    defaultValue,
    onChange,
    min,
    max,
    step = 1,
    precision,
    stringMode = false,
    controls = true,
    keyboard = true,
    size = 'default',
    status,
    prefix,
    suffix,
    addonAfter,
    disabled,
    readOnly,
    className,
    style,
    onFocus,
    onBlur,
    onKeyDown,
    'aria-invalid': ariaInvalid,
    ref,
    ...props
  }: NumberInputProps<T>,
  forwardedRef: React.ForwardedRef<HTMLInputElement>,
) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<T | null>(() => (defaultValue ?? null) as T | null);
  const committed = isControlled ? (value ?? null) : internal;

  const [isFocused, setIsFocused] = React.useState(false);
  const [draft, setDraft] = React.useState<string>(() => formatDisplay(committed, precision, stringMode));
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!isFocused) {
      setDraft(formatDisplay(committed, precision, stringMode));
    }
  }, [committed, isFocused, precision, stringMode]);

  const attachInput = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      const targetRef = ref ?? forwardedRef;
      if (typeof targetRef === 'function') targetRef(node);
      else if (targetRef) (targetRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [forwardedRef, ref],
  );

  const minNum = toFiniteNumber(min);
  const maxNum = toFiniteNumber(max);
  const stepNum = toFiniteNumber(step) ?? 1;

  const emitValue = React.useCallback(
    (next: T | null) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  const stepBy = React.useCallback(
    (direction: 1 | -1) => {
      if (disabled || readOnly) return;
      const currentNum = toFiniteNumber(isFocused ? draft : (committed as number | string | null)) ?? (minNum !== undefined && minNum > 0 ? minNum - stepNum : 0);
      const scale = Math.max(decimalsOf(currentNum), decimalsOf(step));
      const factor = 10 ** Math.min(scale, 12);
      const rawNext = (Math.round(currentNum * factor) + direction * Math.round(stepNum * factor)) / factor;
      const bounded = clampAndRound(rawNext, minNum, maxNum, precision, scale);
      const formatted = precision !== undefined ? bounded.toFixed(precision) : String(bounded);
      setDraft(formatted);
      emitValue((stringMode ? formatted : bounded) as T);
    },
    [committed, disabled, draft, emitValue, isFocused, maxNum, minNum, precision, readOnly, step, stepNum, stringMode],
  );

  const [wheelHost, setWheelHost] = React.useState<HTMLElement | null>(null);
  const attachRoot = React.useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    setWheelHost(node);
  }, []);

  const isInputFocused = () => {
    const el = inputRef.current;
    return Boolean(el && !el.disabled && !el.readOnly && document.activeElement === el);
  };

  useWheelStep(
    wheelHost,
    (isUp) => stepBy(isUp ? 1 : -1),
    !disabled && !readOnly && keyboard !== false,
    isInputFocused,
  );

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setDraft(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      emitValue(null);
      return;
    }
    if (stringMode) {
      emitValue(trimmed as T);
      return;
    }
    if (trimmed === '-' || trimmed === '.' || trimmed === '-.') return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const bounded = clampAndRound(parsed, minNum, maxNum, precision, decimalsOf(trimmed));
    emitValue(bounded as T);
  };

  const commitDraftOnBlur = () => {
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
      if (trimmed !== '' && !stringMode) {
        setDraft(formatDisplay(committed, precision, stringMode));
      } else if (trimmed === '') {
        setDraft('');
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      if (!stringMode) setDraft(formatDisplay(committed, precision, stringMode));
      return;
    }
    const bounded = clampAndRound(parsed, minNum, maxNum, precision, decimalsOf(trimmed));
    const formatted = precision !== undefined ? bounded.toFixed(precision) : (stringMode ? String(bounded) : String(bounded));
    setDraft(stringMode ? trimmed : formatted);
    if (!stringMode && bounded !== committed) {
      emitValue(bounded as T);
    } else if (stringMode && minNum !== undefined && parsed < minNum) {
      const clampedText = String(minNum);
      setDraft(clampedText);
      emitValue(clampedText as T);
    } else if (stringMode && maxNum !== undefined && parsed > maxNum) {
      const clampedText = String(maxNum);
      setDraft(clampedText);
      emitValue(clampedText as T);
    }
  };

  const isSmall = size === 'sm' || size === 'small';
  const isLarge = size === 'large';
  const isInvalid = ariaInvalid === true || ariaInvalid === 'true' || status === 'error';
  const currentNumeric = toFiniteNumber(isFocused ? draft : (committed as number | string | null));

  return (
    <div
      ref={attachRoot}
      data-slot="number-input"
      data-disabled={disabled ? '' : undefined}
      data-invalid={isInvalid ? '' : undefined}
      style={style}
      onMouseDown={(event) => {
        if (event.target === inputRef.current || (event.target instanceof Element && event.target.closest('button'))) return;
        event.preventDefault();
        inputRef.current?.focus();
      }}
      className={cn(
        'group/num inline-flex items-center gap-1.5 rounded-md border-0 bg-field text-foreground shadow-well font-mono tabular-nums',
        'transition-[background-color,box-shadow]',
        'hover:not-focus-within:not-data-disabled:bg-field-hover hover:not-focus-within:not-data-disabled:shadow-field-hover',
        'focus-within:shadow-field-focus',
        isInvalid && 'shadow-field-invalid focus-within:shadow-field-invalid-focus',
        disabled && 'cursor-not-allowed opacity-50',
        isSmall ? 'h-7 pl-2 pr-1.5 text-md' : isLarge ? 'h-9 pl-3 pr-2 text-base' : 'h-8 pl-2.5 pr-1.5 text-base',
        !controls && (isSmall ? 'pr-2' : isLarge ? 'pr-3' : 'pr-2.5'),
        className,
      )}
    >
      {prefix !== undefined && prefix !== null && (
        <span data-slot="number-input-prefix" className="inline-flex items-center shrink-0 text-muted-foreground select-none">
          {prefix}
        </span>
      )}
      <input
        {...props}
        ref={attachInput}
        type="text"
        inputMode={precision === 0 ? 'numeric' : 'decimal'}
        role="spinbutton"
        aria-valuenow={currentNumeric}
        aria-valuemin={minNum}
        aria-valuemax={maxNum}
        aria-invalid={isInvalid || ariaInvalid}
        disabled={disabled}
        readOnly={readOnly}
        value={isFocused ? draft : formatDisplay(committed, precision, stringMode)}
        onChange={handleInputChange}
        onFocus={(event) => {
          setIsFocused(true);
          setDraft(formatDisplay(committed, precision, stringMode));
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setIsFocused(false);
          commitDraftOnBlur();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !keyboard || disabled || readOnly) return;
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            stepBy(1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            stepBy(-1);
          }
        }}
        className="flex-1 min-w-0 w-full h-full border-0 bg-transparent p-0 font-mono tabular-nums text-inherit placeholder:font-sans placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
      />
      {(suffix !== undefined && suffix !== null) && (
        <span data-slot="number-input-suffix" className="inline-flex items-center shrink-0 text-muted-foreground text-sm font-sans select-none">
          {suffix}
        </span>
      )}
      {(addonAfter !== undefined && addonAfter !== null) && (
        <span data-slot="number-input-addon" className="inline-flex items-center shrink-0 text-muted-foreground text-sm font-sans select-none">
          {addonAfter}
        </span>
      )}
      {controls && !disabled && !readOnly && (
        <span
          data-slot="number-input-controls"
          className="hidden sm:inline-flex [@media(pointer:coarse)]:hidden flex-col items-center justify-center shrink-0 opacity-0 group-hover/num:opacity-100 group-focus-within/num:opacity-100 transition-opacity"
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={maxNum !== undefined && currentNumeric !== undefined && currentNumeric >= maxNum}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              inputRef.current?.focus();
              stepBy(1);
            }}
            className="flex items-center justify-center w-4 h-3 border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={minNum !== undefined && currentNumeric !== undefined && currentNumeric <= minNum}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              inputRef.current?.focus();
              stepBy(-1);
            }}
            className="flex items-center justify-center w-4 h-3 border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
          >
            <ChevronDown className="size-3" />
          </button>
        </span>
      )}
    </div>
  );
}

export const NumberInput = React.forwardRef(NumberInputInner) as <T extends number | string = number>(
  props: NumberInputProps<T> & React.RefAttributes<HTMLInputElement>,
) => React.ReactElement;
