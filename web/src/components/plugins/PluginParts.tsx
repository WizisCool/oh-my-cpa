import React from 'react';
import { Tooltip } from 'antd';
import { ExternalLinkOutlined, GithubOutlined, PuzzleOutlined } from '../icons';
import { useT } from '../../i18n';
import { isRenderableLogoURL } from '../../types/pluginOAuthProviders';
import { safeExternalURL } from '../../utils/externalUrl';
import styles from './Plugins.module.css';

interface PluginLogoProps {
  logo?: string;
}

/**
 * A plugin's own mark, or the generic plugin glyph.
 *
 * Only inline artwork is drawn: the server inlines a declared logo or drops it, so a
 * remote URL reaching here would be a defect, and it falls back rather than loading.
 */
export function PluginLogo({ logo }: PluginLogoProps) {
  const [hasFailed, setHasFailed] = React.useState(false);
  const isDrawable = isRenderableLogoURL(logo) && !hasFailed;
  return (
    <span className={styles.logo} aria-hidden="true" data-plugin-logo={isDrawable ? 'image' : 'fallback'}>
      {isDrawable ? <img src={logo} alt="" onError={() => setHasFailed(true)} /> : <PuzzleOutlined size="55%" />}
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
