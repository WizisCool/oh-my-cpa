import React from 'react';
import { Button } from '@/components/ui/button';
import { CheckOutlined, CopyOutlined } from '../icons';
import { useI18n } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { useToast } from '../feedback';
import { Tooltip } from './Tooltip';

const COPIED_MS = 1500;

export interface CopyButtonProps {
  text: string;
  label?: string;
  size?: 'small' | 'middle' | 'sm' | 'default';
  disabled?: boolean;
  className?: string;
  showLabel?: boolean;
}

export function CopyButton({ text, label, size = 'sm', disabled, className, showLabel = false }: CopyButtonProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [hasCopied, setHasCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  const name = hasCopied ? t('common.copied') : (label ?? t('common.copy'));
  const onClick = async () => {
    if (!(await copyText(text))) {
      toast.error(t('common.copy_failed'));
      return;
    }
    setHasCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHasCopied(false), COPIED_MS);
  };

  const resolvedSize = size === 'small' || size === 'sm' ? 'sm' : 'default';
  const icon = hasCopied ? <CheckOutlined /> : <CopyOutlined />;
  const copyState = hasCopied ? 'copied' : undefined;
  if (showLabel) {
    return (
      <Button
        size={resolvedSize}
        className={className}
        disabled={disabled}
        icon={icon}
        data-copy-state={copyState}
        onClick={() => void onClick()}
      >
        {label ?? t('common.copy')}
      </Button>
    );
  }
  return (
    <Tooltip title={name}>
      <Button
        variant="ghost"
        size={resolvedSize}
        className={className}
        aria-label={name}
        data-copy-state={copyState}
        disabled={disabled}
        icon={icon}
        onClick={() => void onClick()}
      />
    </Tooltip>
  );
}
