import React from 'react';
import { Button, Tooltip, type ButtonProps } from 'antd';

/**
 * True inside an action menu's panel. A menu lists its actions as rows, where a glyph alone names
 * nothing, so a tool drawn there takes its label back.
 */
export const LabelledActionsContext = React.createContext(false);

export interface ToolButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'title'> {
  icon: React.ReactNode;
  /** The accessible name, the tooltip, and the row's text inside a menu. */
  label: string;
  /** What hovering shows when it should say more than the name. */
  tooltip?: React.ReactNode;
}

/**
 * A page's secondary action: one square glyph, named by its tooltip and its accessible name.
 *
 * Every secondary control in a page header and a toolbar is this, so they share one size and one
 * resting weight whatever their names' lengths in each language - a row of labelled buttons is
 * as wide as its words, and moving between pages made the row reflow under the pointer. The
 * page's primary action keeps its label: it is the one a reader looks for by name.
 */
export const ToolButton = React.forwardRef<HTMLButtonElement, ToolButtonProps>(
  ({ icon, label, tooltip, ...buttonProps }, ref) => {
    const isLabelled = React.useContext(LabelledActionsContext);
    if (isLabelled) {
      return <Button ref={ref} icon={icon} {...buttonProps}>{label}</Button>;
    }
    return (
      <Tooltip title={tooltip ?? label}>
        <Button ref={ref} icon={icon} aria-label={label} {...buttonProps} />
      </Tooltip>
    );
  },
);
ToolButton.displayName = 'ToolButton';
