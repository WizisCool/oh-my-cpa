import React from 'react';
import clsx from 'clsx';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from '@/components/ui/dialog';
import { Button, type ButtonProps } from '@/components/ui/button';
import { CloseOutlined, LeftOutlined } from '../icons';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { useT } from '../../i18n';
import { Tooltip } from './Tooltip';
import styles from './AppModal.module.css';

const MODAL_WIDTHS = {
  small: 440,
  medium: 560,
  large: 720,
  wide: 1120,
} as const;

export type AppModalSize = keyof typeof MODAL_WIDTHS;

export interface AppModalProps {
  open?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: AppModalSize;
  footer?: React.ReactNode | ((originNode: React.ReactNode, extra: { OkBtn: React.FC; CancelBtn: React.FC }) => React.ReactNode);
  footerStart?: React.ReactNode;
  onCancel?: () => void;
  onOk?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  okText?: React.ReactNode;
  cancelText?: React.ReactNode;
  confirmLoading?: boolean;
  okButtonProps?: ButtonProps;
  cancelButtonProps?: ButtonProps;
  onBack?: () => void;
  isDismissible?: boolean;
  hasOwnScroll?: boolean;
  destroyOnHidden?: boolean;
  keyboard?: boolean;
  mask?: boolean | { closable?: boolean };
  zIndex?: number;
  afterOpenChange?: (open: boolean) => void;
  className?: string;
  children?: React.ReactNode;
  'data-testid'?: string;
}

export function AppModal({
  open = false,
  title,
  description,
  size = 'medium',
  footer,
  footerStart,
  onCancel,
  onOk,
  okText,
  cancelText,
  confirmLoading = false,
  okButtonProps,
  cancelButtonProps,
  onBack,
  isDismissible = true,
  hasOwnScroll = false,
  destroyOnHidden = false,
  keyboard = true,
  mask = true,
  zIndex = 1000,
  afterOpenChange,
  className,
  children,
  'data-testid': testId,
}: AppModalProps) {
  const t = useT();
  const [hasOpened, setHasOpened] = React.useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const [isScrolled, setIsScrolled] = React.useState(false);
  const viewport = useVisibleViewport(open);
  const sheetSpan = useOpenSheetSpan(open, MODAL_WIDTHS[size]);

  const maskConfig = typeof mask === 'object' && mask !== null ? mask : {};
  const canDismissByEscape = isDismissible && keyboard !== false;
  const canDismissByBackdrop = isDismissible && maskConfig.closable !== false;

  const cancelAction = (
    <Button key="cancel" onClick={() => onCancel?.()} {...cancelButtonProps}>
      {cancelText ?? t('common.cancel')}
    </Button>
  );
  const okAction = (
    <Button key="ok" variant="primary" loading={confirmLoading} onClick={(e) => onOk?.(e as React.MouseEvent<HTMLButtonElement>)} {...okButtonProps}>
      {okText ?? t('common.confirm')}
    </Button>
  );
  const defaultActions = (
    <>
      {cancelAction}
      {okAction}
    </>
  );

  const renderedActions =
    typeof footer === 'function'
      ? footer(defaultActions, {
          OkBtn: () => okAction,
          CancelBtn: () => cancelAction,
        })
      : footer === undefined
        ? defaultActions
        : footer;

  const hasStart = footerStart !== undefined && footerStart !== null && footerStart !== false;
  const showFooter = renderedActions !== null || hasStart;

  if (!hasOpened && !open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          if (details.reason === 'escape-key' && !canDismissByEscape) {
            details.cancel();
            return;
          }
          if (details.reason === 'outside-press' && !canDismissByBackdrop) {
            details.cancel();
            return;
          }
          if (
            details.reason === 'outside-press' &&
            details.event.target instanceof Element &&
            details.event.target.closest('[data-slot="select-content"], [data-slot="combobox-content"]')
          ) {
            details.cancel();
            return;
          }
          onCancel?.();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setIsScrolled(false);
        afterOpenChange?.(next);
      }}
    >
      <DialogPortal keepMounted={hasOpened && !destroyOnHidden}>
        {mask !== false && (
          <DialogBackdrop
            data-slot="dialog-backdrop"
            style={{ zIndex }}
            className="omc-overlay-backdrop fixed inset-0 bg-overlay"
          />
        )}
        <DialogViewport
          data-slot="dialog-viewport"
          style={
            {
              zIndex: zIndex + 1,
              '--sheet-height': `${viewport.height}px`,
              '--sheet-bottom': `${viewport.bottom}px`,
              ...(sheetSpan && { paddingInlineStart: sheetSpan.start, paddingInlineEnd: sheetSpan.end }),
            } as React.CSSProperties
          }
          className={clsx('fixed inset-0 overflow-y-auto', styles['wrapper'])}
        >
          <DialogPopup
            data-slot="dialog-content"
            data-testid={testId}
            style={{ width: `min(${MODAL_WIDTHS[size]}px, calc(100vw - 32px))` }}
            className={clsx(
              'omc-dialog-surface app-modal bg-elevated text-foreground shadow-overlay outline-none',
              styles['modal'],
              styles['container'],
              className,
            )}
          >
            <header className={clsx(styles['header'], isScrolled && styles['is-scrolled'])}>
              {onBack && (
                <Tooltip title={t('common.back')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles['back']}
                    icon={<LeftOutlined />}
                    aria-label={t('common.back')}
                    onClick={onBack}
                  />
                </Tooltip>
              )}
              <div className={clsx(styles['titles'], onBack && styles['has-back'])}>
                <DialogTitle className={clsx('m-0', styles['title'], styles['title-text'])}>
                  {title}
                </DialogTitle>
                {description !== undefined && description !== null && description !== false && (
                  <DialogDescription render={<div />} className={clsx('m-0', styles['description'])}>
                    {description}
                  </DialogDescription>
                )}
              </div>
              {isDismissible && (
                <DialogClose
                  aria-label={t('common.close')}
                  className={clsx(
                    'position-absolute inline-flex items-center justify-center border-0 bg-transparent p-0 cursor-pointer',
                    styles['close'],
                  )}
                  style={{ position: 'absolute' }}
                >
                  <CloseOutlined />
                </DialogClose>
              )}
            </header>

            <div className={styles['body']}>
              <div
                className={clsx(styles['scroll'], hasOwnScroll && styles['is-fixed'])}
                onScroll={(event) => {
                  const next = event.currentTarget.scrollTop > 0;
                  if (next !== isScrolled) setIsScrolled(next);
                }}
              >
                {children}
              </div>
            </div>

            {showFooter && (
              <footer className={styles['footer']}>
                {hasStart ? (
                  <div className={styles['footer-row']}>
                    <div className={styles['footer-start']}>{footerStart}</div>
                    {renderedActions !== null && <div className={styles['footer-actions']}>{renderedActions}</div>}
                  </div>
                ) : (
                  renderedActions
                )}
              </footer>
            )}
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}

/** Room a dialog keeps on each side of it inside the span it is centred in. */
const SPAN_GUTTER = 16;

/**
 * Where an open side sheet stands, as the inline insets that centre a dialog over it.
 *
 * A side sheet is modal, so a dialog that opens while one is open was opened from it. Centred on
 * the window, the dialog straddled the sheet's edge and hung half over the dimmed page, a card
 * floating loose over two surfaces; centred on the sheet - which steps back under it - it reads as
 * the next layer of the same stack. A dialog wider than the sheet, and a phone's bottom sheet,
 * keep the window's centre.
 */
function useOpenSheetSpan(open: boolean, width: number) {
  const [span, setSpan] = React.useState<{ start: number; end: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const sheets = document.querySelectorAll<HTMLElement>('[data-slot="sheet-content"][data-open]');
      const box = sheets[sheets.length - 1]?.getBoundingClientRect();
      const fits = box && window.innerWidth > 640 && box.width >= width + 2 * SPAN_GUTTER;
      setSpan(fits ? { start: box.left, end: window.innerWidth - box.right } : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, width]);
  return span;
}
