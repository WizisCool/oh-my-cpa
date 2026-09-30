import React from 'react';
import { Input } from 'antd';
import type { InputProps } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined } from '../icons';
import { useT } from '../../i18n';
import styles from './SecretInput.module.css';

/**
 * Whether the engine can mask a text field's characters with CSS. Every engine
 * the console supports does; the check keeps an engine that cannot from showing
 * a secret in the clear, by falling back to a password field there.
 */
const CAN_MASK_TEXT =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');

/**
 * Attributes that opt the field out of password-manager extensions, which look
 * for credentials on their own rather than through the browser's heuristics.
 */
const MANAGER_OPT_OUT = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

export interface SecretInputProps extends Omit<InputProps, 'type' | 'suffix'> {
  /** Controlled visibility; left unset, the field keeps its own. */
  isVisible?: boolean;
  onVisibleChange?: (isVisible: boolean) => void;
}

/**
 * A masked field for a secret that belongs to something other than the person
 * signed in: an upstream provider key, a gateway client key.
 *
 * A password field there is the wrong signal to the browser. It fills the
 * console's own sign-in password into the first one it finds, and after a save
 * it offers to store the provider key as the console's login. Only the sign-in
 * form is a credential of this site, so every other secret is a text field that
 * masks its characters instead.
 */
export function SecretInput({ isVisible, onVisibleChange, className, ...inputProps }: SecretInputProps) {
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

  const isMaskedByStyle = CAN_MASK_TEXT && !isShown;
  return (
    <Input
      {...MANAGER_OPT_OUT}
      {...inputProps}
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
