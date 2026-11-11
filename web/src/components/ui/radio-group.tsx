import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { cn } from '@/lib/utils';

export function RadioGroup({
  className,
  ...props
}: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('flex flex-wrap items-center gap-4', className)}
      {...props}
    />
  );
}

export interface RadioItemProps extends Omit<RadioPrimitive.Root.Props, 'children'> {
  children?: React.ReactNode;
}

export function RadioItem({ className, children, ...props }: RadioItemProps) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-base text-foreground select-none [@media(pointer:coarse)]:min-h-10', props.disabled && 'cursor-not-allowed opacity-50', className)}>
      <RadioPrimitive.Root
        data-slot="radio-item"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border-0 bg-field shadow-well outline-none transition-shadow focus-visible:shadow-focus data-[checked]:bg-brand"
        {...props}
      >
        <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-brand-foreground" />
      </RadioPrimitive.Root>
      {children ? <span>{children}</span> : null}
    </label>
  );
}
