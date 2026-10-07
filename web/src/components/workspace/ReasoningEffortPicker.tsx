import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { BulbOutlined, CheckOutlined, DownOutlined } from '../icons';
import { useI18n } from '../../i18n';
import styles from './Workspace.module.css';

/**
 * The effort levels offered by name. Providers spell their levels differently and some accept
 * values outside this list; a stored value that is not here is still shown and kept.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** The menu key for "leave it to the model", which sends no effort at all. */
const DEFAULT_KEY = 'model-default';

export interface ReasoningEffortPickerProps {
  /** Empty for the model's own default. */
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}

/**
 * A reasoning-effort choice that sits in the composer's foot.
 *
 * It is a quiet text button naming the current level rather than a labelled select: the level is
 * set once and read often, and the composer is where the reader's eye already is when it matters -
 * just before sending. "Default" means the field is left out of the request, not a level of its own.
 */
export function ReasoningEffortPicker({ value, onChange, isDisabled = false }: ReasoningEffortPickerProps) {
  const { t } = useI18n();
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const levels = React.useMemo(
    () => (value && !REASONING_EFFORTS.includes(value) ? [...REASONING_EFFORTS, value] : REASONING_EFFORTS),
    [value],
  );
  const selectedKey = value || DEFAULT_KEY;
  const mark = (key: string) => (key === selectedKey ? <CheckOutlined className={styles['effort-check']} /> : <span className={styles['effort-check']} />);
  const labelOf = (level: string) => (REASONING_EFFORTS.includes(level) ? t(`conversation.reasoning_effort.${level}`) : level);
  const items: MenuProps['items'] = [
    { key: DEFAULT_KEY, icon: mark(DEFAULT_KEY), label: t('conversation.model_default') },
    { type: 'divider' },
    ...levels.map(level => ({ key: level, icon: mark(level), label: labelOf(level) })),
  ];
  const current = value ? labelOf(value) : t('pg.default');

  return (
    <Dropdown
      trigger={['click']}
      disabled={isDisabled}
      onOpenChange={setIsMenuOpen}
      menu={{ items, selectable: true, selectedKeys: [selectedKey], onClick: ({ key }) => onChange(key === DEFAULT_KEY ? '' : key) }}
    >
      {/* The tooltip names the control; once its menu is open the menu does, and the two would overlap. */}
      <Tooltip title={t('conversation.reasoning_effort')} open={isMenuOpen ? false : undefined}>
        <Button
          type="text"
          size="small"
          className={styles['effort-trigger']}
          aria-label={`${t('conversation.reasoning_effort')}: ${current}`}
          disabled={isDisabled}
          icon={<BulbOutlined />}
        >
          <span className={styles['effort-value']}>{current}</span>
          <DownOutlined className={styles['effort-caret']} aria-hidden="true" />
        </Button>
      </Tooltip>
    </Dropdown>
  );
}
