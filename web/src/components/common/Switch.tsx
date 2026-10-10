import React from 'react';
import clsx from 'clsx';
import styles from './Switch.module.css';

export type SwitchSize = 'default' | 'small';

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role' | 'children' | 'value'> {
  checked?: boolean;
  onChange?: (checked: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  /** `small` is the row density: a list, a table cell or a toolbar. */
  size?: SwitchSize;
  /** A write for this switch is in flight: the state is held and the thumb reads as pending. */
  loading?: boolean;
}

/**
 * The console's one on/off control.
 *
 * It is drawn for the console - a rounded rectangle with a concentric thumb - rather than taken
 * as a pill, and it states its value three ways: the side the thumb is on, the track's fill,
 * and a bar or ring on the track, so the reading never rests on colour. The element is a native button
 * with `role="switch"`, which is what keeps a wrapping `<label>`, `htmlFor`, Space/Enter and a
 * `Form.Item` with `valuePropName="checked"` working without any wiring of their own.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked = false, onChange, size = 'default', loading = false, disabled = false, className, onClick, ...attributes }, ref,
) {
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) onChange?.(!checked, event);
  };
  return (
    <button
      aria-busy={loading || undefined}
      {...attributes}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || loading}
      className={clsx(
        styles['switch'],
        size === 'small' && styles['is-small'],
        checked && styles['is-checked'],
        loading && styles['is-loading'],
        className,
      )}
      onClick={handleClick}
    >
      <span className={styles['thumb']} aria-hidden="true" />
    </button>
  );
});
