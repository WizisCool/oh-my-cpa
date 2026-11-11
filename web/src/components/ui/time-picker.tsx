import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, '0');
}

export function minuteOfDayToClock(minute: number): string {
  const clamped = ((Math.floor(minute) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

export function clockToMinuteOfDay(clock: string): number | null {
  const match = CLOCK_RE.exec(clock.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface TimePickerProps {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export function TimePicker({
  id,
  value = '',
  onChange,
  disabled,
  placeholder = '00:00',
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: TimePickerProps) {
  return (
    <div
      data-slot="time-picker"
      data-testid={testId}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border-0 bg-field px-2.5 text-base text-foreground shadow-well transition-[background-color,box-shadow] hover:not-focus-within:bg-field-hover hover:not-focus-within:shadow-field-hover focus-within:shadow-field-focus [@media(pointer:coarse)]:min-h-10',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        id={id}
        type="time"
        step={60}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange?.(e.target.value)}
        className="h-full min-w-[76px] flex-1 border-0 bg-transparent p-0 text-base text-foreground tabular-nums outline-none disabled:cursor-not-allowed [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

export interface TimeRangeFieldProps {
  startValue: string;
  endValue: string;
  onChange: (next: { start: string; end: string }) => void;
  disabled?: boolean;
  startLabel?: string;
  endLabel?: string;
  className?: string;
  'aria-label'?: string;
}

export function TimeRangeField({
  startValue,
  endValue,
  onChange,
  disabled,
  startLabel,
  endLabel,
  className,
  'aria-label': ariaLabel,
}: TimeRangeFieldProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="time-range-field"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border-0 bg-field px-2.5 text-base text-foreground shadow-well transition-[background-color,box-shadow] hover:not-focus-within:bg-field-hover hover:not-focus-within:shadow-field-hover focus-within:shadow-field-focus [@media(pointer:coarse)]:min-h-10',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        type="time"
        step={60}
        value={startValue}
        disabled={disabled}
        aria-label={startLabel ?? (ariaLabel ? `${ariaLabel} start` : 'Start time')}
        onChange={(e) => onChange({ start: e.target.value, end: endValue })}
        className="h-full min-w-[68px] border-0 bg-transparent p-0 text-base text-foreground tabular-nums outline-none disabled:cursor-not-allowed [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <span className="text-xs text-muted-foreground select-none" aria-hidden="true">
        –
      </span>
      <input
        type="time"
        step={60}
        value={endValue}
        disabled={disabled}
        aria-label={endLabel ?? (ariaLabel ? `${ariaLabel} end` : 'End time')}
        onChange={(e) => onChange({ start: startValue, end: e.target.value })}
        className="h-full min-w-[68px] border-0 bg-transparent p-0 text-base text-foreground tabular-nums outline-none disabled:cursor-not-allowed [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}
