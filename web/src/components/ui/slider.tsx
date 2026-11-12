import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '@/lib/utils';

export interface SliderProps {
  id?: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange?: (value: number) => void;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function Slider({
  id,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onChange,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      id={id}
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => {
        const numeric = Array.isArray(next) ? next[0] : next;
        if (typeof numeric === 'number') onChange?.(numeric);
      }}
      className={cn('relative flex w-full touch-none items-center py-2 select-none data-[disabled]:opacity-50', className)}
    >
      <SliderPrimitive.Control className="relative flex w-full cursor-pointer items-center py-1.5 [@media(pointer:coarse)]:py-2.5">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full rounded-xs bg-field shadow-well"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-indicator"
            className="h-full rounded-xs bg-brand transition-colors"
          />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className="block size-3.5 rounded-full border-0 bg-foreground [:root[data-theme-mode=light]_&]:bg-background shadow-raised outline-none transition-transform hover:scale-110 focus-visible:shadow-focus [@media(pointer:coarse)]:size-4.5"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
