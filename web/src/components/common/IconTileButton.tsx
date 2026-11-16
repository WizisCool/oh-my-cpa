import React from 'react';
import clsx from 'clsx';
import styles from './IconTileButton.module.css';

export interface IconTileButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'type' | 'children'> {
  /** The accessible name and the tooltip: the glyph alone does not say the tile is pressable. */
  label: string;
  /** `md` (32px) inside a card or row, `lg` (48px) at the head of a drawer. */
  size?: 'md' | 'lg';
  children: React.ReactNode;
}

/**
 * An entity's mark as the control that changes it: pressing the icon opens the icon picker.
 *
 * The tile is a flat ink wash rather than a second shadowed edge, because it usually stands
 * inside a card or a drawer head that already carries one.
 */
export const IconTileButton = React.forwardRef<HTMLButtonElement, IconTileButtonProps>(
  ({ label, size = 'md', className, children, ...buttonProps }, ref) => (
    <button
      ref={ref}
      type="button"
      className={clsx(styles['icon-tile'], styles[`is-${size}`], className)}
      aria-label={label}
      data-tip={label}
      {...buttonProps}
    >
      {children}
    </button>
  ),
);
IconTileButton.displayName = 'IconTileButton';
