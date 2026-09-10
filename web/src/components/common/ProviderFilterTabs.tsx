import React from 'react';
import { Tabs, Space } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';
import { LobeIcon } from '../LobeIcon';
import { getCredentialProviderMetadata } from './providerMetadata';
import { useT } from '../../i18n';
import styles from './ProviderFilterTabs.module.css';

export interface ProviderFilterTabsProps {
  providers: string[];
  counts: Record<string, number>;
  active: string;
  onChange: (provider: string) => void;
}

/**
 * Shared provider filter tabs built on Ant Design Tabs, bent to the
 * terminal-flat spec:
 * - quiet underline with a var(--fg) ink bar, never antd blue
 * - mono count pills over var(--surface)/var(--border-soft), tabular numerals
 * - explicit provider brand icons (Codex, Claude, Antigravity, xAI, Kimi)
 */
export const ProviderFilterTabs: React.FC<ProviderFilterTabsProps> = ({
  providers,
  counts,
  active,
  onChange,
}) => {
  const t = useT();

  const items = providers.map((provider) => {
    const isAll = provider === 'all';
    const isActive = provider === active;
    const meta = isAll ? null : getCredentialProviderMetadata(provider);
    const label = isAll ? t('common.all') : meta?.label ?? provider;
    const iconId = isAll ? null : meta?.iconId ?? '';
    const count = counts[provider] ?? 0;

    return {
      key: provider,
      label: (
        <Space size={6} align="center">
          <span className={styles['tab-icon']}>
            {iconId ? (
              <LobeIcon iconId={iconId} size={15} />
            ) : (
              <AppstoreOutlined style={{ fontSize: 14, color: isActive ? 'var(--fg)' : 'var(--meta)' }} />
            )}
          </span>
          <span>{label}</span>
          <span className={`${styles['tab-count']} ${isActive ? styles['tab-count-active'] : ''}`}>
            {count}
          </span>
        </Space>
      ),
    };
  });

  return (
    <div className={styles['tabs-wrap']}>
      <Tabs
        activeKey={active}
        onChange={onChange}
        items={items}
        size="small"
      />
    </div>
  );
};
