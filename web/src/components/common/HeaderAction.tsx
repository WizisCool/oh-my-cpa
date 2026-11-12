import React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import styles from './HeaderAction.module.css';
import { Tooltip } from './Tooltip';

interface HeaderActionProps extends Omit<ButtonProps, 'variant' | 'size' | 'title'> {
  label: string;
  tooltip?: string | false;
  tone?: 'default' | 'muted';
  isLabelFolded?: boolean;
}

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
      <Button ref={ref} variant="ghost" className={classNames} aria-label={accessibleLabel} {...buttonProps}>
        {label && isLabelFolded ? <span className={styles['fold']}>{label}</span> : label}
      </Button>
    );
    return tooltip === false ? button : <Tooltip title={tooltip ?? accessibleLabel}>{button}</Tooltip>;
  },
);
HeaderAction.displayName = 'HeaderAction';
