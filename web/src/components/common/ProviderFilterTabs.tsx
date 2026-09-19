import React from 'react';
import { Tabs, Space } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';
import { credentialProviderIconId, getCredentialProviderMetadata } from './providerMetadata';
import { ProviderBrandIcon } from '../LobeIcon';
import { pluginOAuthLogoFor, type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { useT } from '../../i18n';
import styles from './ProviderFilterTabs.module.css';

export interface ProviderFilterTabsProps {
  providers: string[];
  counts: Record<string, number>;
  active: string;
  onChange: (provider: string) => void;
  /** Logos published by installed plugins, keyed by the OAuth provider they register. */
  pluginLogos?: PluginOAuthLogos;
}

/**
 * Shared provider filter tabs built on Ant Design Tabs, bent to the
 * terminal-flat spec:
 * - quiet underline with a var(--fg) ink bar, never antd blue
 * - mono count pills over var(--surface)/var(--border-soft), tabular numerals
 * - the provider's own brand mark, from its plugin when a plugin owns it and from
 *   the vendored catalog otherwise (Codex, Claude, Antigravity, xAI, Kimi, Devin,
 *   Meta, and any plugin-registered provider)
 *
 * The mark is resolved through `credentialProviderIconId` rather than read off the
 * display table alone: a provider the table has not been taught yet must still
 * render the brand artwork the bundle already ships, instead of a neutral glyph
 * that hides which provider a tab belongs to.
 */
export const ProviderFilterTabs: React.FC<ProviderFilterTabsProps> = ({
  providers,
  counts,
  active,
  onChange,
  pluginLogos,
}) => {
  const t = useT();

  const items = providers.map((provider) => {
    const isAll = provider === 'all';
    const isActive = provider === active;
    const meta = isAll ? null : getCredentialProviderMetadata(provider);
    const label = isAll ? t('common.all') : meta?.label ?? provider;
    const iconId = isAll ? '' : credentialProviderIconId(provider, label);
    const logo = isAll ? undefined : pluginOAuthLogoFor(pluginLogos, provider);
    const count = counts[provider] ?? 0;

    return {
      key: provider,
      label: (
        <Space size={6} align="center">
          <span className={styles['tab-icon']}>
            {iconId || logo ? (
              <ProviderBrandIcon iconId={iconId} logo={logo} size={15} />
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
