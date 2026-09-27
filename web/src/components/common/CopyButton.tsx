import React from 'react';
import { App, Button, Tooltip } from 'antd';
import { CheckOutlined, CopyOutlined } from '../icons';
import { useI18n } from '../../i18n';
import { copyText } from '../../utils/clipboard';

/** How long the check mark stands in for the copy glyph after a successful copy. */
const COPIED_MS = 1500;

export interface CopyButtonProps {
  text: string;
  /** The accessible name and tooltip; defaults to the console's plain "Copy". */
  label?: string;
  size?: 'small' | 'middle';
  disabled?: boolean;
  className?: string;
  /** Draws the label beside the glyph, for a place where two copy actions sit side by side. */
  showLabel?: boolean;
}

/**
 * An icon button that copies a value and acknowledges it in place.
 *
 * The acknowledgement is the glyph turning into a check mark, not a toast: a transcript carries a
 * copy action on every answer and every code block, and a toast per click stacks messages at the
 * top of the page about an action the reader is looking straight at. A failure still raises a
 * toast, because a copy that silently did nothing is the one outcome the reader cannot see.
 */
export function CopyButton({ text, label, size = 'small', disabled, className, showLabel = false }: CopyButtonProps) {
  const { t } = useI18n();
  const { message } = App.useApp();
  const [hasCopied, setHasCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  const name = hasCopied ? t('common.copied') : (label ?? t('common.copy'));
  const onClick = async () => {
    if (!(await copyText(text))) {
      message.error(t('common.copy_failed'));
      return;
    }
    setHasCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHasCopied(false), COPIED_MS);
  };

  const icon = hasCopied ? <CheckOutlined /> : <CopyOutlined />;
  if (showLabel) {
    // The label stays the action's name while the glyph acknowledges the copy, so the button keeps
    // its width and the control beside it does not move.
    return (
      <Button size={size} className={className} disabled={disabled} icon={icon} onClick={() => void onClick()}>
        {label ?? t('common.copy')}
      </Button>
    );
  }
  return (
    <Tooltip title={name}>
      <Button
        type="text"
        size={size}
        className={className}
        aria-label={name}
        disabled={disabled}
        icon={icon}
        onClick={() => void onClick()}
      />
    </Tooltip>
  );
}
