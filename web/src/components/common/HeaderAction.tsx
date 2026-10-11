import React from 'react';
import { Button, Tooltip, type ButtonProps } from 'antd';
import styles from './HeaderAction.module.css';

interface HeaderActionProps extends Omit<ButtonProps, 'type' | 'size' | 'shape' | 'title'> {
  /** The control's name, shown on hover. */
  tooltip: string;
  /** The accessible name, when it must say more than the tooltip does; defaults to the tooltip. */
  accessibleLabel?: string;
  /** `muted` recedes an action that is rarely the one reached for. */
  tone?: 'default' | 'muted';
}

/**
 * One control in the header's action cluster.
 *
 * Every action there - link, toggle, menu trigger - is this component, so they share one
 * height, one resting weight, one hover and one way of naming themselves. A control that
 * carries a short reading beside its icon (a count, a language code) passes it as children
 * and gets the same label treatment as the others instead of a form of its own; that is
 * what keeps the cluster reading as a row of equals rather than five designs.
 *
 * Props and the ref pass through to the button so a `Dropdown` can use it as its trigger.
 */
export const HeaderAction = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, HeaderActionProps>(
  ({ tooltip, accessibleLabel, tone = 'default', className, children, ...buttonProps }, ref) => {
    const hasLabel = children !== undefined && children !== null && children !== false;
    const classNames = [
      styles['action'],
      hasLabel ? styles['labelled'] : '',
      tone === 'muted' ? styles['muted'] : '',
      className,
    ].filter(Boolean).join(' ');
    return (
      <Tooltip title={tooltip}>
        <Button ref={ref} type="text" className={classNames} aria-label={accessibleLabel ?? tooltip} {...buttonProps}>
          {hasLabel ? <span className={styles['label']}>{children}</span> : null}
        </Button>
      </Tooltip>
    );
  },
);
HeaderAction.displayName = 'HeaderAction';
