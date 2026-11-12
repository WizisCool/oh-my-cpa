import React from 'react';
import { hasHigherOpenOverlay } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogViewport,
} from '@/components/ui/alert-dialog';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useT } from '../../i18n';

export interface ConfirmModalOptions {
  title: React.ReactNode;
  content?: React.ReactNode;
  icon?: React.ReactNode;
  okText?: React.ReactNode;
  cancelText?: React.ReactNode;
  danger?: boolean;
  okButtonProps?: ButtonProps;
  onOk?: () => unknown | Promise<unknown>;
  onCancel?: () => void;
}

export interface ConfirmModalHandle {
  destroy: () => void;
}

export type ConfirmModalFn = (options: ConfirmModalOptions) => ConfirmModalHandle;

interface ActiveConfirm extends ConfirmModalOptions {
  id: number;
  isOpen: boolean;
}

let nextConfirmId = 0;
let activeListener: ((item: ActiveConfirm | null) => void) | null = null;
let currentItem: ActiveConfirm | null = null;

function publishConfirm(item: ActiveConfirm | null) {
  currentItem = item;
  activeListener?.(item);
}

export function clearActiveConfirmModal() {
  publishConfirm(null);
}

export function confirmModal(options: ConfirmModalOptions): ConfirmModalHandle {
  nextConfirmId += 1;
  const id = nextConfirmId;
  publishConfirm({ ...options, id, isOpen: true });
  return {
    destroy: () => {
      if (currentItem?.id === id) publishConfirm(null);
    },
  };
}

export function useConfirmModal(): { confirm: ConfirmModalFn } {
  return React.useMemo(() => ({ confirm: confirmModal }), []);
}

export function ConfirmDialogHost() {
  const t = useT();
  const [item, setItem] = React.useState<ActiveConfirm | null>(currentItem);
  const [isPending, setIsPending] = React.useState(false);
  const popupRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    activeListener = setItem;
    setItem(currentItem);
    return () => {
      if (activeListener === setItem) activeListener = null;
    };
  }, []);

  if (!item) return null;

  const isDanger = Boolean(item.danger || item.okButtonProps?.danger);

  const handleCancel = () => {
    if (isPending) return;
    const target = item;
    publishConfirm(null);
    target.onCancel?.();
  };

  const handleConfirm = async () => {
    if (isPending) return;
    const target = item;
    if (!target.onOk) {
      publishConfirm(null);
      return;
    }
    try {
      const result = target.onOk();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        setIsPending(true);
        await result;
      }
      if (currentItem?.id === target.id) publishConfirm(null);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AlertDialog
      open={item.isOpen}
      onOpenChange={(next, details) => {
        if (!next) {
          if (
            (details.reason === 'escape-key' || details.reason === 'outside-press') &&
            ((details.reason === 'escape-key' && details.event.defaultPrevented) ||
              hasHigherOpenOverlay(1081, popupRef.current))
          ) {
            details.cancel();
            return;
          }
          handleCancel();
        }
      }}
    >
      <AlertDialogPortal>
        <AlertDialogBackdrop
          data-slot="alert-dialog-backdrop"
          style={{ zIndex: 1080 }}
          className="omc-overlay-backdrop fixed inset-0 z-[1080] bg-overlay"
        />
        <AlertDialogViewport style={{ zIndex: 1081 }} className="fixed inset-0 z-[1081] flex items-center justify-center p-4 max-sm:items-end max-sm:p-0">
          <AlertDialogPopup
            ref={popupRef}
            role="dialog"
            data-slot="alert-dialog-content"
            className="omc-dialog-surface flex w-[min(440px,calc(100vw-32px))] max-sm:w-full flex-col gap-4 rounded-xl max-sm:rounded-b-none bg-elevated p-6 max-sm:px-5 max-sm:pt-5 max-sm:pb-[max(20px,env(safe-area-inset-bottom))] max-sm:[&_[data-slot=button]]:min-h-10 text-foreground shadow-overlay outline-none"
          >
            <div className="flex flex-col gap-1.5">
              <AlertDialogTitle className="m-0 text-lg font-semibold leading-snug text-foreground break-words">
                {item.title}
              </AlertDialogTitle>
              {item.content !== undefined && item.content !== null && item.content !== false && (
                <AlertDialogDescription render={<div />} className="m-0 text-base leading-normal text-fg-2 break-words">
                  {item.content}
                </AlertDialogDescription>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button disabled={isPending} onClick={handleCancel}>
                {item.cancelText ?? t('common.cancel')}
              </Button>
              <Button
                variant={isDanger ? 'destructive' : 'primary'}
                danger={isDanger}
                loading={isPending}
                onClick={() => void handleConfirm()}
                {...item.okButtonProps}
              >
                {item.okText ?? t('common.confirm')}
              </Button>
            </div>
          </AlertDialogPopup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
