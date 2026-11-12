import * as React from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';

export type FloatingPlacement =
  | 'top'
  | 'topLeft'
  | 'topRight'
  | 'bottom'
  | 'bottomLeft'
  | 'bottomRight'
  | 'left'
  | 'leftTop'
  | 'leftBottom'
  | 'right'
  | 'rightTop'
  | 'rightBottom';

export function resolveFloatingPlacement(placement: FloatingPlacement = 'bottom'): {
  side: 'top' | 'bottom' | 'left' | 'right';
  align: 'start' | 'center' | 'end';
} {
  switch (placement) {
    case 'topLeft': return { side: 'top', align: 'start' };
    case 'topRight': return { side: 'top', align: 'end' };
    case 'top': return { side: 'top', align: 'center' };
    case 'bottomLeft': return { side: 'bottom', align: 'start' };
    case 'bottomRight': return { side: 'bottom', align: 'end' };
    case 'left': return { side: 'left', align: 'center' };
    case 'leftTop': return { side: 'left', align: 'start' };
    case 'leftBottom': return { side: 'left', align: 'end' };
    case 'right': return { side: 'right', align: 'center' };
    case 'rightTop': return { side: 'right', align: 'start' };
    case 'rightBottom': return { side: 'right', align: 'end' };
    case 'bottom':
    default:
      return { side: 'bottom', align: 'center' };
  }
}

export interface PopoverProps extends Omit<PopoverPrimitive.Root.Props, 'onOpenChange'> {
  onOpenChange?: (open: boolean, details: PopoverPrimitive.Root.ChangeEventDetails) => void;
  afterOpenChange?: (open: boolean) => void;
}

export function Popover({ onOpenChange, afterOpenChange, ...props }: PopoverProps) {
  return (
    <PopoverPrimitive.Root
      {...props}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.reason === 'outside-press' &&
          details.event.target instanceof Element &&
          details.event.target.closest('[data-slot="select-content"], [data-slot="combobox-content"]')
        ) {
          details.cancel();
          return;
        }
        onOpenChange?.(next, details);
      }}
      onOpenChangeComplete={afterOpenChange}
    />
  );
}

const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;
const PopoverDescription = PopoverPrimitive.Description;

export interface PopoverContentProps extends Omit<PopoverPrimitive.Popup.Props, 'className'> {
  side?: PopoverPrimitive.Positioner.Props['side'];
  align?: PopoverPrimitive.Positioner.Props['align'];
  placement?: FloatingPlacement;
  sideOffset?: number;
  alignOffset?: number;
  anchor?: PopoverPrimitive.Positioner.Props['anchor'];
  keepMounted?: boolean;
  positionerClassName?: string;
  positionerStyle?: React.CSSProperties;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
}

export function PopoverContent({
  side,
  align,
  placement,
  sideOffset = 6,
  alignOffset = 0,
  anchor,
  keepMounted = false,
  positionerClassName,
  positionerStyle,
  className,
  children,
  ref,
  ...props
}: PopoverContentProps) {
  const resolved = placement ? resolveFloatingPlacement(placement) : undefined;
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        anchor={anchor}
        side={side ?? resolved?.side ?? 'bottom'}
        align={align ?? resolved?.align ?? 'center'}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={12}
        style={{ zIndex: 1050, ...positionerStyle }}
        className={cn('z-[1050] outline-none', positionerClassName)}
      >
        <PopoverPrimitive.Popup
          ref={ref}
          data-slot="popover-content"
          className={cn(
            'omc-float-surface max-w-[calc(100vw-24px)] rounded-lg bg-popover p-3 text-base text-popover-foreground shadow-float outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export {
  PopoverTrigger,
  PopoverClose,
  PopoverTitle,
  PopoverDescription,
  PopoverPrimitive,
};
