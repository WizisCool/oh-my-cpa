import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn } from '@/lib/utils';
import { useSelectionThumb } from './selection-thumb';

export type ToggleGroupSize = 'default' | 'sm';

const ToggleGroupSizeContext = React.createContext<ToggleGroupSize>('default');

export interface ToggleGroupProps extends Omit<ToggleGroupPrimitive.Props, 'className'> {
  size?: ToggleGroupSize;
  block?: boolean;
  className?: string;
}

export function ToggleGroup({
  size = 'default',
  block = false,
  orientation = 'horizontal',
  className,
  children,
  multiple = false,
  ...props
}: ToggleGroupProps) {
  // Several options can be on at once only in a multiple group, which has no one place to glide to.
  const thumbRef = useSelectionThumb<HTMLDivElement>('[data-slot="toggle-group-item"][data-pressed]', 'data-pressed', !multiple);
  return (
    <ToggleGroupSizeContext.Provider value={size}>
      <ToggleGroupPrimitive
        ref={thumbRef}
        data-slot="toggle-group"
        orientation={orientation}
        multiple={multiple}
        className={cn(
          'omc-thumb-host inline-flex rounded-md bg-field p-0.5 shadow-well select-none',
          orientation === 'vertical' ? 'flex-col items-stretch' : 'items-center',
          block && 'flex w-full',
          className,
        )}
        {...props}
      >
        {children}
      </ToggleGroupPrimitive>
    </ToggleGroupSizeContext.Provider>
  );
}

export interface ToggleGroupItemProps extends Omit<TogglePrimitive.Props, 'className'> {
  className?: string;
}

export function ToggleGroupItem({ className, children, ...props }: ToggleGroupItemProps) {
  const size = React.useContext(ToggleGroupSizeContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border-0 bg-transparent font-normal text-fg-2 cursor-pointer',
        'transition-[background-color,color,box-shadow] touch-manipulation',
        'hover:not-data-disabled:not-data-pressed:text-foreground',
        'data-pressed:bg-thumb data-pressed:font-medium data-pressed:text-foreground data-pressed:shadow-control',
        'in-data-thumb:data-pressed:bg-transparent in-data-thumb:data-pressed:shadow-none',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        size === 'sm' ? 'min-h-6 px-2.5 py-0.5 text-md' : 'min-h-7 px-3 py-1 text-md',
        '[@media(pointer:coarse)]:min-h-[30px]',
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}
