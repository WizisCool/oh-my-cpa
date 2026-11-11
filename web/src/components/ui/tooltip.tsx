import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps extends Omit<TooltipPrimitive.Popup.Props, 'className'> {
  side?: TooltipPrimitive.Positioner.Props['side'];
  align?: TooltipPrimitive.Positioner.Props['align'];
  sideOffset?: number;
  anchor?: TooltipPrimitive.Positioner.Props['anchor'];
  className?: string;
}

function TooltipContent({
  side = 'top',
  align = 'center',
  sideOffset = 6,
  anchor,
  className,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-[1070] pointer-events-none"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip"
          className={cn(
            'omc-float-surface max-w-[320px] rounded-md bg-tooltip px-2.5 py-1.5 text-sm leading-snug text-tooltip-foreground shadow-float break-words',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipPrimitive };
