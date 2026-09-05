import React from 'react';
import { Tabs, Badge, Space } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { useT } from '../../i18n';

interface ProviderTabsProps {
  providers: string[];
  counts: Record<string, number>;
  active: string;
  onChange: (provider: string) => void;
}

export const ProviderTabs: React.FC<ProviderTabsProps> = ({
  providers,
  counts,
  active,
  onChange,
}) => {
  const t = useT();

  const items = providers.map((provider) => {
    const label =
      provider === 'all'
        ? t('af.all_providers')
        : provider.charAt(0).toUpperCase() + provider.slice(1);
    const iconId = provider === 'all' ? null : getProviderDefaultIcon(provider);
    const count = counts[provider] ?? 0;

    return {
      key: provider,
      label: (
        <Space size={6} align="center">
          {iconId ? (
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <LobeIcon iconId={iconId} size={15} />
            </span>
          ) : (
            <AppstoreOutlined />
          )}
          <span>{label}</span>
          <Badge
            count={count}
            overflowCount={999}
            style={{
              backgroundColor: provider === active ? 'var(--accent)' : 'var(--border)',
              color: provider === active ? '#fff' : 'var(--muted)',
              fontSize: 10,
              boxShadow: 'none',
            }}
          />
        </Space>
      ),
    };
  });

  return (
    <div style={{ marginBottom: 16 }}>
      <Tabs activeKey={active} onChange={onChange} items={items} size="small" />
    </div>
  );
};
