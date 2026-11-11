import React from 'react';
import { Input, type InputProps } from '@/components/ui/input';
import { EyeInvisibleOutlined, EyeOutlined } from '../icons';
import { useT } from '../../i18n';
import styles from './SecretInput.module.css';

const CAN_MASK_TEXT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');

const MANAGER_OPT_OUT = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

export interface SecretInputProps extends Omit<InputProps, 'type' | 'suffix' | 'size'> {
  isVisible?: boolean;
  onVisibleChange?: (isVisible: boolean) => void;
  size?: InputProps['size'] | 'small' | 'middle' | 'large';
}

export function SecretInput({ isVisible, onVisibleChange, size, className, ...inputProps }: SecretInputProps) {
  const t = useT();
  const [isOwnVisible, setIsOwnVisible] = React.useState(false);
  const isShown = isVisible ?? isOwnVisible;
  const toggleLabel = isShown ? t('common.hide_secret') : t('common.reveal_secret');

  const toggle = (
    <button
      type="button"
      className={styles['toggle']}
      aria-label={toggleLabel}
      title={toggleLabel}
      aria-pressed={isShown}
      onClick={() => {
        setIsOwnVisible(!isShown);
        onVisibleChange?.(!isShown);
      }}
    >
      {isShown ? <EyeOutlined /> : <EyeInvisibleOutlined />}
    </button>
  );

  const resolvedSize: InputProps['size'] =
    size === 'small' ? 'sm' : size === 'large' ? 'lg' : size === 'middle' ? 'default' : size;
  const isMaskedByStyle = CAN_MASK_TEXT && !isShown;

  return (
    <Input
      {...MANAGER_OPT_OUT}
      {...inputProps}
      size={resolvedSize}
      type={CAN_MASK_TEXT || isShown ? 'text' : 'password'}
      autoComplete={CAN_MASK_TEXT ? 'off' : 'new-password'}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      suffix={toggle}
      className={[isMaskedByStyle ? styles['masked'] : '', className ?? ''].filter(Boolean).join(' ') || undefined}
    />
  );
}
