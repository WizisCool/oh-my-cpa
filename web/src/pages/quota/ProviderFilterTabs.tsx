import React from 'react';
import { AppstoreOutlined } from '@ant-design/icons';
import { LobeIcon } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import styles from './QuotaPage.module.css';

// Brand icons for the fixed provider tabs; extras fall back to the
// family-based matcher. Labels are brand names, identical in zh/en.
const PROVIDER_ICONS: Record<string, string> = {
  claude: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex',
  xai: 'XAI',
  kimi: 'Kimi',
};

interface ProviderFilterTabsProps {
  providers: string[];
  counts: Record<string, number>;
  active: string;
  onChange: (provider: string) => void;
}

/**
 * CPAMC-style provider filter tabs: quiet underline row, brand color only on
 * the icons, mono count pills. Horizontal scroll on narrow screens.
 */
export const ProviderFilterTabs: React.FC<ProviderFilterTabsProps> = ({
  providers,
  counts,
  active,
  onChange,
}) => {
  const t = useT();
  return (
    <div className={styles.filterTabs} role="group" aria-label={t('quota.filter_tabs')}>
      {providers.map((provider) => {
        const isActive = provider === active;
        const label = provider === 'all'
          ? t('common.all')
          : provider.charAt(0).toUpperCase() + provider.slice(1);
        const iconId = provider === 'all' ? null : PROVIDER_ICONS[provider] ?? null;
        return (
          <button
            key={provider}
            type="button"
            className={`${styles.filterTab} ${isActive ? styles.filterTabActive : ''}`}
            aria-pressed={isActive}
            onClick={() => onChange(provider)}
          >
            {iconId ? (
              <span className={styles.filterTabIcon}>
                <LobeIcon iconId={iconId} size={15} />
              </span>
            ) : (
              <AppstoreOutlined className={styles.filterTabGlyph} />
            )}
            <span className={styles.filterTabLabel}>{label}</span>
            <span className={styles.filterTabCount}>{counts[provider] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
};
