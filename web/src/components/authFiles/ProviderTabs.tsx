import React from 'react';
import { AppstoreOutlined } from '@ant-design/icons';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { useT } from '../../i18n';
import styles from '../../pages/authFiles/AuthFilesPage.module.css';

interface ProviderTabsProps {
  providers: string[];
  counts: Record<string, number>;
  active: string;
  onChange: (provider: string) => void;
}

/**
 * CPAMC / Quota Management unified provider filter tabs:
 * quiet underline row, brand color only on icons, mono count pills, active indicator using var(--fg).
 */
export const ProviderTabs: React.FC<ProviderTabsProps> = ({
  providers,
  counts,
  active,
  onChange,
}) => {
  const t = useT();

  return (
    <div className={styles.filterTabs} role="group" aria-label={t('common.all')}>
      {providers.map((provider) => {
        const isActive = provider === active;
        const label =
          provider === 'all'
            ? t('common.all')
            : provider.charAt(0).toUpperCase() + provider.slice(1);
        const iconId = provider === 'all' ? null : getProviderDefaultIcon(provider);

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
