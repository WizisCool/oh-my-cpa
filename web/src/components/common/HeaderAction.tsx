import React from 'react';
import { Button, Tooltip, type ButtonProps } from 'antd';
import styles from './HeaderAction.module.css';

interface HeaderActionProps extends Omit<ButtonProps, 'type' | 'size' | 'shape' | 'title'> {
  /** The accessible name. */
  label: string;
  /**
   * What hovering shows: the label unless given, or nothing when `false` - for a control
   * whose own hover already says what it is.
   */
  tooltip?: string | false;
  /** `muted` recedes an action that is rarely the one reached for. */
  tone?: 'default' | 'muted';
  /**
   * Fold the label away until the control is pointed at or focused. For a reading that is
   * worth having on request but not worth a permanent place in the row.
   */
  isLabelFolded?: boolean;
}

/**
 * One control in the header's action cluster.
 *
 * Every action there - link, toggle, menu trigger - is this component, so they share one
 * height, one resting weight, one hover and one accessible name. A control that
 * carries a short reading beside its icon (a count, a language code) passes it as children
 * and gets the same label treatment as the others instead of a form of its own; that is
 * what keeps the cluster reading as a row of equals rather than five designs.
 *
 * A folded label unfolds before the icon rather than after it. The cluster is
 * right-aligned, so a control can only grow to the left: with the label leading, the icon
 * stays where the pointer found it instead of sliding out from under it.
 *
 * Props and the ref pass through to the button so a `Dropdown` can use it as its trigger.
 */
export const HeaderAction = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, HeaderActionProps>(
  ({ label: accessibleLabel, tooltip, tone = 'default', isLabelFolded = false, className, children, ...buttonProps }, ref) => {
    const hasLabel = children !== undefined && children !== null && children !== false;
    const classNames = [
      styles['action'],
      hasLabel && !isLabelFolded ? styles['labelled'] : '',
      hasLabel && isLabelFolded ? styles['folding'] : '',
      tone === 'muted' ? styles['muted'] : '',
      className,
    ].filter(Boolean).join(' ');
    const label = hasLabel ? <span className={styles['label']}>{children}</span> : null;
    const button = (
      <Button ref={ref} type="text" className={classNames} aria-label={accessibleLabel} {...buttonProps}>
        {label && isLabelFolded ? <span className={styles['fold']}>{label}</span> : label}
      </Button>
    );
    return tooltip === false ? button : <Tooltip title={tooltip ?? accessibleLabel}>{button}</Tooltip>;
  },
);
HeaderAction.displayName = 'HeaderAction';
