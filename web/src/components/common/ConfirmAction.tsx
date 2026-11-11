import React from 'react';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  type FloatingPlacement,
} from '@/components/ui/popover';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useT } from '../../i18n';
import { Tooltip } from './Tooltip';

export interface ConfirmActionProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  isDanger?: boolean;
  isConfirming?: boolean;
  confirmButtonProps?: ButtonProps;
  tooltip?: React.ReactNode;
  placement?: FloatingPlacement;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm?: (event?: React.MouseEvent<HTMLElement>) => unknown | Promise<unknown>;
  onCancel?: (event?: React.MouseEvent<HTMLElement>) => void;
  children: React.ReactElement;
}

export function ConfirmAction({
  title,
  description,
  confirmLabel,
  isDanger = false,
  isConfirming = false,
  confirmButtonProps,
  tooltip,
  placement = 'top',
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  onConfirm,
  onCancel,
  children,
}: ConfirmActionProps) {
  const t = useT();
  const [isOwnOpen, setIsOwnOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);
  const isOpen = disabled ? false : (controlledOpen ?? isOwnOpen);

  const setOpen = (next: boolean) => {
    if (disabled && next) return;
    if (controlledOpen === undefined) setIsOwnOpen(next);
    onOpenChange?.(next);
  };

  const handleConfirm = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onConfirm) {
      setOpen(false);
      return;
    }
    try {
      const result = onConfirm(event);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        setIsPending(true);
        await result;
      }
      setOpen(false);
    } finally {
      setIsPending(false);
    }
  };

  const handleCancel = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onCancel?.(event);
    setOpen(false);
  };

  if (disabled) {
    return tooltip === undefined ? children : <Tooltip title={tooltip}>{children}</Tooltip>;
  }

  const triggerElement =
    tooltip === undefined ? (
      children
    ) : (
      <Tooltip title={tooltip} open={isOpen ? false : undefined}>
        {children}
      </Tooltip>
    );

  const isNativeButton = children.type === 'button' || children.type === Button;

  return (
    <Popover open={isOpen} onOpenChange={(next) => setOpen(next)}>
      <PopoverTrigger nativeButton={isNativeButton} render={triggerElement} />
      <PopoverContent
        placement={placement}
        role="dialog"
        className="w-[min(320px,calc(100vw-24px))] p-3.5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <PopoverTitle className="m-0 text-base font-semibold leading-snug text-foreground">
              {title}
            </PopoverTitle>
            {description !== undefined && description !== null && description !== false && (
              <PopoverDescription render={<div />} className="m-0 text-sm leading-normal text-fg-2 break-words">
                {description}
              </PopoverDescription>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" onClick={handleCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant={isDanger ? 'destructive' : 'primary'}
              danger={isDanger}
              loading={isConfirming || isPending}
              onClick={(e) => void handleConfirm(e as React.MouseEvent<HTMLButtonElement>)}
              {...confirmButtonProps}
            >
              {confirmLabel ?? t('common.confirm')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
