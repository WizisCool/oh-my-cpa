import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveFloatingPlacement, type FloatingPlacement } from './popover';

export interface DropdownMenuProps extends Omit<MenuPrimitive.Root.Props, 'onOpenChange'> {
  onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({ onOpenChange, ...props }: DropdownMenuProps) {
  return (
    <MenuPrimitive.Root
      {...props}
      onOpenChange={(next) => onOpenChange?.(next)}
    />
  );
}

const DropdownMenuTrigger = MenuPrimitive.Trigger;
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export interface DropdownMenuContentProps extends Omit<MenuPrimitive.Popup.Props, 'className'> {
  side?: MenuPrimitive.Positioner.Props['side'];
  align?: MenuPrimitive.Positioner.Props['align'];
  placement?: FloatingPlacement;
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
}

export function DropdownMenuContent({
  side,
  align,
  placement,
  sideOffset = 6,
  alignOffset = 0,
  className,
  children,
  ...props
}: DropdownMenuContentProps) {
  const resolved = placement ? resolveFloatingPlacement(placement) : undefined;
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side ?? resolved?.side ?? 'bottom'}
        align={align ?? resolved?.align ?? 'end'}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="z-[1060] outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'omc-float-surface min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-float outline-none select-none',
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export interface DropdownMenuItemProps extends Omit<MenuPrimitive.Item.Props, 'className'> {
  icon?: React.ReactNode;
  danger?: boolean;
  className?: string;
}

export function DropdownMenuItem({
  icon,
  danger = false,
  className,
  children,
  ...props
}: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-danger={danger ? '' : undefined}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-md text-foreground no-underline outline-none cursor-pointer',
        'transition-colors',
        'data-highlighted:bg-hover',
        danger && 'text-danger data-highlighted:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] data-highlighted:text-danger',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {icon !== undefined && icon !== null && (
        <span className={cn('inline-flex items-center shrink-0', !danger && 'text-muted-foreground')} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">{children}</span>
    </MenuPrimitive.Item>
  );
}

export interface DropdownMenuRadioItemProps extends Omit<MenuPrimitive.RadioItem.Props, 'className'> {
  icon?: React.ReactNode;
  className?: string;
}

export function DropdownMenuRadioItem({
  icon,
  closeOnClick = true,
  className,
  children,
  ...props
}: DropdownMenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      closeOnClick={closeOnClick}
      data-slot="dropdown-menu-radio-item"
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-md text-foreground outline-none cursor-pointer',
        'transition-colors',
        'data-highlighted:bg-hover',
        'data-checked:bg-selected data-checked:font-medium',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {icon !== undefined && icon !== null && (
        <span className="inline-flex items-center shrink-0" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">{children}</span>
      <MenuPrimitive.RadioItemIndicator className="inline-flex items-center shrink-0 text-brand">
        <Check className="size-3.5" aria-hidden="true" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-1 h-px bg-border-soft', className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dropdown-menu-label"
      className={cn('px-2.5 py-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export { DropdownMenuTrigger, DropdownMenuRadioGroup, MenuPrimitive };
