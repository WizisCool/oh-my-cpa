import React from 'react';
import { Button, Modal } from 'antd';
import type { ModalProps } from 'antd';
import clsx from 'clsx';
import { CloseOutlined, LeftOutlined } from '../icons';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { useT } from '../../i18n';
import { Tooltip } from './Tooltip';
import styles from './AppModal.module.css';

/** Each width is capped at the viewport; a phone gets a bottom sheet whatever the size. */
const MODAL_WIDTHS = {
  small: 440,
  medium: 560,
  large: 720,
  wide: 1120,
} as const;

export type AppModalSize = keyof typeof MODAL_WIDTHS;

export interface AppModalProps
  extends Omit<ModalProps, 'width' | 'title' | 'closable' | 'centered' | 'closeIcon' | 'classNames' | 'styles'> {
  title: React.ReactNode;
  /** One line under the title saying what the dialog is for, when the title alone does not. */
  description?: React.ReactNode;
  /**
   * `small` asks one question, `medium` holds a short form, `large` a list or a multi-part task,
   * `wide` a table or a preview.
   */
  size?: AppModalSize;
  /** Shown opposite the footer's actions: a state note or a secondary link. */
  footerStart?: React.ReactNode;
  /** A dialog that has stepped into a sub-view offers the way back beside its title. */
  onBack?: () => void;
  /** False while work the dialog started cannot be abandoned: no close glyph, Esc or mask click. */
  isDismissible?: boolean;
  /** The body is a fixed frame whose content scrolls itself (a long list with its own viewport). */
  hasOwnScroll?: boolean;
}

/**
 * A dialog over the page: a question, a short form, or one task that needs the reader's full
 * attention and ends by going back to where they were.
 *
 * The head stays put while the body scrolls under it, and a hairline appears below the head only
 * once something has scrolled beneath it. Actions sit in a footer pinned to the bottom edge. On a
 * phone the same dialog rises from the bottom as a sheet, where the thumb already is.
 */
export function AppModal({
  title,
  description,
  size = 'medium',
  footer,
  footerStart,
  onBack,
  isDismissible = true,
  hasOwnScroll = false,
  className,
  children,
  mask,
  ...rest
}: AppModalProps) {
  const t = useT();
  const [isScrolled, setIsScrolled] = React.useState(false);
  // A phone's sheet is sized from the visible viewport, not 100dvh: Android shrinks only the
  // visual viewport for the keyboard, which would leave a focused form's footer under it.
  const viewport = useVisibleViewport(!!rest.open);
  const hasStart = footerStart !== undefined && footerStart !== null && footerStart !== false;
  // antd draws OK/Cancel when `footer` is left undefined; a start slot wraps whichever it is.
  const resolvedFooter: ModalProps['footer'] = hasStart
    ? (origin, extra) => (
        <div className={styles['footer-row']}>
          <div className={styles['footer-start']}>{footerStart}</div>
          <div className={styles['footer-actions']}>
            {typeof footer === 'function' ? footer(origin, extra) : footer === undefined ? origin : footer}
          </div>
        </div>
      )
    : footer;
  const maskConfig = typeof mask === 'object' && mask !== null ? mask : {};
  return (
    <Modal
      {...rest}
      className={clsx('app-modal', styles['modal'], className)}
      width={`min(${MODAL_WIDTHS[size]}px, calc(100vw - 32px))`}
      footer={resolvedFooter}
      keyboard={isDismissible && rest.keyboard !== false}
      mask={{ ...maskConfig, closable: isDismissible && maskConfig.closable !== false }}
      closable={isDismissible ? { 'aria-label': t('common.close') } : false}
      closeIcon={<CloseOutlined />}
      styles={{
        wrapper: {
          '--sheet-height': `${viewport.height}px`,
          '--sheet-bottom': `${viewport.bottom}px`,
        } as React.CSSProperties,
      }}
      classNames={{
        wrapper: styles['wrapper'],
        container: styles['container'],
        header: clsx(styles['header'], isScrolled && styles['is-scrolled']),
        title: styles['title'],
        close: styles['close'],
        body: styles['body'],
        footer: styles['footer'],
      }}
      afterOpenChange={(open) => {
        if (!open) setIsScrolled(false);
        rest.afterOpenChange?.(open);
      }}
      title={
        <div className={clsx(styles['titles'], onBack && styles['has-back'])}>
          <span className={styles['title-text']}>{title}</span>
          {description && <span className={styles['description']}>{description}</span>}
        </div>
      }
    >
      {/* The back step sits beside the title but outside the element that names the dialog, so the
          dialog's accessible name is its title rather than "Back" followed by it. */}
      {onBack && (
        <Tooltip title={t('common.back')}>
          <Button
            type="text"
            size="small"
            className={styles['back']}
            icon={<LeftOutlined />}
            aria-label={t('common.back')}
            onClick={onBack}
          />
        </Tooltip>
      )}
      <div
        className={clsx(styles['scroll'], hasOwnScroll && styles['is-fixed'])}
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop > 0;
          if (next !== isScrolled) setIsScrolled(next);
        }}
      >
        {children}
      </div>
    </Modal>
  );
}
