import React, { useState } from 'react';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { useT } from '../i18n';

/** `sk-ab…1234` style preview; short keys collapse to bullets only. */
export function maskKeyText(key?: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  const prefixLen = trimmed.length < 12 ? 2 : 4;
  return trimmed.slice(0, prefixLen) + '••••••••' + trimmed.slice(-4);
}

interface MaskedTextProps {
  value?: string;
  style?: React.CSSProperties;
}

/**
 * Shows a masked preview by default; the eye button toggles the real value.
 * The plaintext must already be available client-side (API keys are returned
 * in full by the management API).
 */
export const MaskedText: React.FC<MaskedTextProps> = ({ value, style }) => {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const trimmed = (value || '').trim();
  if (!trimmed) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...style }}>
      <span
        title={trimmed}
        style={{
          fontFamily: 'monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {revealed ? trimmed : maskKeyText(trimmed)}
      </span>
      <button
        type="button"
        aria-label={revealed ? t('common.hide_secret') : t('common.reveal_secret')}
        title={revealed ? t('common.hide_secret') : t('common.reveal_secret')}
        onClick={(e) => {
          e.stopPropagation();
          setRevealed((prev) => !prev);
        }}
        style={{
          border: 'none',
          background: 'transparent',
          padding: '0 2px',
          cursor: 'pointer',
          color: 'var(--meta)',
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: 12,
        }}
      >
        {revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
      </button>
    </span>
  );
};
