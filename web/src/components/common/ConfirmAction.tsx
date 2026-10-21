import React from 'react';
import { Popconfirm, Tooltip } from 'antd';
import type { ButtonProps, PopconfirmProps } from 'antd';
import { useT } from '../../i18n';

export interface ConfirmActionProps
  extends Omit<PopconfirmProps, 'okText' | 'cancelText' | 'okButtonProps' | 'okType'> {
  /** The verb on the confirming button - "Delete", "Restore" - where "Confirm" would not say what happens. */
  confirmLabel?: React.ReactNode;
  /** The action destroys something, so the confirming button takes the danger colour. */
  isDanger?: boolean;
  /** The confirmed write is in flight. */
  isConfirming?: boolean;
  /** Further attributes for the confirming button, such as an accessible name. */
  confirmButtonProps?: ButtonProps;
  /**
   * The trigger's own tooltip. It is held here rather than wrapped around the trigger by the
   * caller because it must step aside while the confirmation is open: left up, it sat over the
   * confirmation's buttons, and over Cancel when both open above the trigger.
   */
  tooltip?: React.ReactNode;
}

/**
 * The second step in front of an action that cannot be taken back, anchored to its trigger.
 *
 * Sixteen call sites spelled the two buttons out each time, and only some of the ones that delete
 * remembered to colour the confirming button, so the same act looked safe on one page and dangerous
 * on the next. The cancel label is fixed here; a caller states only what differs.
 */
export function ConfirmAction({
  confirmLabel,
  isDanger = false,
  isConfirming = false,
  confirmButtonProps,
  tooltip,
  children,
  open,
  onOpenChange,
  ...rest
}: ConfirmActionProps) {
  const t = useT();
  const [isOwnOpen, setIsOwnOpen] = React.useState(false);
  const isOpen = open ?? isOwnOpen;
  return (
    <Popconfirm
      {...rest}
      open={open}
      onOpenChange={(next: boolean) => {
        setIsOwnOpen(next);
        onOpenChange?.(next);
      }}
      okText={confirmLabel ?? t('common.confirm')}
      cancelText={t('common.cancel')}
      okButtonProps={{ ...confirmButtonProps, danger: isDanger, loading: isConfirming || undefined }}
    >
      {tooltip === undefined ? children : (
        <Tooltip title={tooltip} open={isOpen ? false : undefined}>
          {children}
        </Tooltip>
      )}
    </Popconfirm>
  );
}
