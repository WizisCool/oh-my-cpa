import React from 'react';

import { ExternalLinkOutlined, GithubOutlined, InfoCircleOutlined, PuzzleOutlined, SafetyCertificateOutlined, WarningOutlined } from '../icons';
import { useT } from '../../i18n';
import { BrandArtwork } from '../common/BrandArtwork';
import { PluginIcon } from './PluginIcon';
import type { StorePluginOrigin } from './pluginStoreLogic';
import { safeExternalURL } from '../../utils/externalUrl';
import styles from './Plugins.module.css';
import { Tooltip } from '../common/Tooltip';
import { Tag } from '../common/Tag';
import { StatusLabel } from '../common/StatusLabel';
import type { PluginItem } from '../../types/plugin';

interface PluginLogoProps {
  logo?: string;
}

/** The framed plugin mark used by management cards and page headings. */
export function PluginLogo({ logo }: PluginLogoProps) {
  return (
    <span className={styles.logo} data-plugin-logo-chip aria-hidden="true">
      {/* A list of registries can publish dozens of marks; the ones below the fold are not read. */}
      <PluginIcon logo={logo} fallbackSize="55%" loading="lazy" />
    </span>
  );
}

interface PluginLinksProps {
  repositoryURL?: string;
  homepage?: string;
}

/** The repository and homepage links a plugin publishes, as icon buttons. */
export function PluginLinks({ repositoryURL, homepage }: PluginLinksProps) {
  const t = useT();
  const repository = safeExternalURL(repositoryURL);
  const home = safeExternalURL(homepage);
  if (!repository && !home) return null;
  return (
    <span className={styles['card-links']}>
      {repository && (
        <Tooltip title={t('plugin.open_repository')}>
          <a className={styles['icon-link']} href={repository} target="_blank" rel="noreferrer noopener" aria-label={t('plugin.open_repository')}>
            <GithubOutlined />
          </a>
        </Tooltip>
      )}
      {home && home !== repository && (
        <Tooltip title={t('plugin.open_homepage')}>
          <a className={styles['icon-link']} href={home} target="_blank" rel="noreferrer noopener" aria-label={t('plugin.open_homepage')}>
            <ExternalLinkOutlined />
          </a>
        </Tooltip>
      )}
    </span>
  );
}

/** A one-line fact list separated by middots; empty entries are dropped. */
export function PluginMeta({ items }: { items: Array<React.ReactNode | undefined | false> }) {
  const visible = items.filter((item) => item !== undefined && item !== false && item !== '' && item !== null);
  if (visible.length === 0) return null;
  return (
    <div className={styles.meta}>
      {visible.map((item, index) => (
        <span key={index} className={styles['meta-item']}>{item}</span>
      ))}
    </div>
  );
}

/** A version as the plugin declares it: `v` is added once, never doubled. */
export function formatPluginVersion(version: string | undefined): string {
  const trimmed = (version ?? '').trim();
  if (!trimmed) return '';
  return /^v\d/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

/**
 * Where a listed plugin comes from, as one mark. Its five states keep two facts apart that
 * the operator would otherwise have to infer: which registry listed the entry, and whether
 * that registry's publisher maintains the code. `official-source` and `omc-community` are
 * the cases that otherwise read as first-party - a first-party catalogue, a community
 * author's repository.
 */
export function PluginOriginBadge({ origin }: { origin: StorePluginOrigin }) {
  const t = useT();
  switch (origin) {
    case 'omc':
      return (
        <Tag size="small" tone="accent" icon={<BrandArtwork shape="mark" height={11} />} data-plugin-origin={origin}>
          {t('plugin.badge_omc')}
        </Tag>
      );
    case 'omc-community':
      return <Tag size="small" icon={<PuzzleOutlined />} data-plugin-origin={origin}>{t('plugin.badge_omc_community')}</Tag>;
    case 'official':
      return <Tag size="small" tone="success" icon={<SafetyCertificateOutlined />} data-plugin-origin={origin}>{t('plugin.badge_official')}</Tag>;
    case 'official-source':
      return <Tag size="small" icon={<InfoCircleOutlined />} data-plugin-origin={origin}>{t('plugin.badge_official_source')}</Tag>;
    default:
      return <Tag size="small" tone="warn" icon={<WarningOutlined />} data-plugin-origin={origin}>{t('plugin.badge_third_party')}</Tag>;
  }
}

/**
 * Whether a plugin runs, in words: "enabled" alone is not what an operator needs, since a
 * plugin can be switched on and still not run while the plugin system is off or the host
 * has not registered it.
 */
export function PluginStateLabel({ plugin, isPluginSystemEnabled }: { plugin: PluginItem; isPluginSystemEnabled: boolean }) {
  const t = useT();
  if (plugin.effective_enabled) return <StatusLabel tone="success">{t('plugin.state_running')}</StatusLabel>;
  if (!plugin.enabled) return <StatusLabel tone="neutral">{t('plugin.state_disabled')}</StatusLabel>;
  return (
    <Tooltip title={isPluginSystemEnabled ? t('plugin.state_waiting_register') : t('plugin.state_waiting_system')}>
      <span><StatusLabel tone="warn">{t('plugin.state_waiting')}</StatusLabel></span>
    </Tooltip>
  );
}
