import React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Tooltip } from './Tooltip';

/**
 * True inside an action menu's panel. A menu lists its actions as rows, where a glyph alone names
 * nothing, so a tool drawn there takes its label back.
 */
export const LabelledActionsContext = React.createContext(false);

export interface ToolButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'title' | 'size'> {
  icon: React.ReactNode;
  /** The accessible name, the tooltip, and the row's text inside a menu. */
  label: string;
  /** What hovering shows when it should say more than the name. */
  tooltip?: React.ReactNode;
  size?: ButtonProps['size'] | 'small' | 'middle' | 'large';
}

function normalizeSize(size: ToolButtonProps['size']): ButtonProps['size'] {
  if (size === 'small') return 'sm';
  if (size === 'large') return 'lg';
  if (size === 'middle') return 'default';
  return size;
}

export const ToolButton = React.forwardRef<HTMLButtonElement, ToolButtonProps>(
  ({ icon, label, tooltip, size, ...buttonProps }, ref) => {
    const isLabelled = React.useContext(LabelledActionsContext);
    const resolvedSize = normalizeSize(size);
    if (isLabelled) {
      return (
        <Button ref={ref} size={resolvedSize} icon={icon} {...buttonProps}>
          {label}
        </Button>
      );
    }
    return (
      <Tooltip title={tooltip ?? label}>
        <Button ref={ref} size={resolvedSize} icon={icon} aria-label={label} {...buttonProps} />
      </Tooltip>
    );
  },
);
ToolButton.displayName = 'ToolButton';
