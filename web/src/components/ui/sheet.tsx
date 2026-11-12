import * as React from 'react';
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SheetSide = 'right' | 'left' | 'top' | 'bottom';

export interface SheetProps extends Omit<SheetPrimitive.Root.Props, 'onOpenChange'> {
  onOpenChange?: (open: boolean, details: SheetPrimitive.Root.ChangeEventDetails) => void;
  afterOpenChange?: (open: boolean) => void;
}

export function Sheet({ onOpenChange, afterOpenChange, ...props }: SheetProps) {
  return (
    <SheetPrimitive.Root
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

export interface SheetContentProps extends Omit<SheetPrimitive.Popup.Props, 'className'> {
  side?: SheetSide;
  /** Floating desktop card inset 8px from viewport edges with --shadow-overlay (AppDrawer contract). */
  floatingDesktop?: boolean;
  /** Surface fill: 'ground' (--bg) for record side-panels, 'elevated' (--elevated) for summoned picker sheets. */
  surface?: 'ground' | 'elevated';
  destroyOnHidden?: boolean;
  hasOpened?: boolean;
  zIndex?: number;
  backdropClassName?: string;
  className?: string;
}

export function SheetContent({
  side = 'right',
  floatingDesktop = false,
  surface = 'elevated',
  destroyOnHidden = false,
  hasOpened = true,
  zIndex = 1000,
  backdropClassName,
  className,
  style,
  children,
  ...props
}: SheetContentProps) {
  if (!hasOpened && !destroyOnHidden) return null;

  return (
    <SheetPrimitive.Portal keepMounted={hasOpened && !destroyOnHidden}>
      <SheetPrimitive.Backdrop
        data-slot="sheet-backdrop"
        style={{ zIndex }}
        className={cn(
          'omc-sheet-backdrop fixed inset-0 bg-overlay',
          backdropClassName,
        )}
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        data-floating-desktop={floatingDesktop ? '' : undefined}
        style={{ zIndex: zIndex + 1, ...style }}
        className={cn(
          'omc-sheet-surface fixed flex flex-col outline-none',
          surface === 'ground' ? 'bg-background text-foreground' : 'bg-elevated text-foreground',
          side === 'right' && [
            'inset-y-0 right-0 max-w-full border-l border-border',
            floatingDesktop && 'min-[901px]:top-2 min-[901px]:bottom-2 min-[901px]:right-2 min-[901px]:rounded-xl min-[901px]:border-l-0 min-[901px]:shadow-overlay',
          ],
          side === 'left' && 'inset-y-0 left-0 max-w-full border-r border-border',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl border-t border-border shadow-overlay',
          side === 'top' && 'inset-x-0 top-0 max-h-[92dvh] rounded-b-xl border-b border-border shadow-overlay',
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

export interface SheetHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  closeLabel?: string;
  hideClose?: boolean;
}

export function SheetHeader({
  title,
  extra,
  closeLabel = 'Close',
  hideClose = false,
  className,
  children,
  ...props
}: SheetHeaderProps) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4 max-sm:px-4 max-sm:py-3.5',
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">
        {title !== undefined && title !== null && (
          <SheetPrimitive.Title
            data-slot="sheet-title"
            className="m-0 text-lg font-semibold leading-snug text-foreground break-words"
          >
            {title}
          </SheetPrimitive.Title>
        )}
        {children}
      </div>
      {(extra !== undefined && extra !== null && extra !== false) && (
        <div className="flex shrink-0 items-center gap-1.5">{extra}</div>
      )}
      {!hideClose && (
        <SheetPrimitive.Close
          data-slot="sheet-close"
          aria-label={closeLabel}
          className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-fg-2 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus cursor-pointer transition-colors [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-1 [@media(pointer:coarse)]:before:content-['']"
        >
          <X className="size-4" aria-hidden="true" />
        </SheetPrimitive.Close>
      )}
    </div>
  );
}

export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn('flex-1 min-h-0 min-w-0 overflow-y-auto p-6 max-sm:p-4 [scrollbar-gutter:stable]', className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('shrink-0 border-t border-border px-6 py-3.5 max-sm:px-4 max-sm:py-3', className)}
      {...props}
    />
  );
}

const SheetTitle = SheetPrimitive.Title;
const SheetClose = SheetPrimitive.Close;

export { SheetTitle, SheetClose, SheetPrimitive };
