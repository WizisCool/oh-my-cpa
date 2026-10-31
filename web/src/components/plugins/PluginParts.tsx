import React from 'react';

import { ExternalLinkOutlined, GithubOutlined } from '../icons';
import { useT } from '../../i18n';
import { PluginIcon } from './PluginIcon';
import { safeExternalURL } from '../../utils/externalUrl';
import styles from './Plugins.module.css';
import { Tooltip } from '../common/Tooltip';

interface PluginLogoProps {
  logo?: string;
}

/** The framed plugin mark used by management cards and page headings. */
export function PluginLogo({ logo }: PluginLogoProps) {
  return (
    <span className={styles.logo} aria-hidden="true">
      <PluginIcon logo={logo} fallbackSize="55%" />
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

interface PluginRowProps {
  logo?: string;
  name: string;
  id: string;
  /** The row's state in words, beside the name. */
  status: React.ReactNode;
  /** Origin and capability marks, after the state. */
  badges?: React.ReactNode;
  meta?: Array<React.ReactNode | undefined | false>;
  description?: string;
  /** Why the plugin is not in the state it was asked for, under the facts. */
  note?: React.ReactNode;
  /** The switch, then the row's tools. */
  control: React.ReactNode;
  tools?: React.ReactNode;
  rowProps?: Record<`data-${string}`, string | boolean | undefined>;
}

/**
 * One plugin in a list. The built-in list and the installed list draw the same row, so a
 * plugin reads the same way wherever it is managed: mark, name and state, its facts, what
 * it does, and its switch at the edge.
 */
export function PluginRow({ logo, name, id, status, badges, meta, description, note, control, tools, rowProps }: PluginRowProps) {
  return (
    <article className={styles['installed-row']} {...rowProps}>
      <PluginLogo logo={logo} />
      <div className={styles['installed-main']}>
        <div className={styles['installed-title']}>
          <span className={styles['installed-name']}>{name}</span>
          <span className={styles.badges}>{status}{badges}</span>
        </div>
        {name !== id && <span className={styles['plugin-id']}>{id}</span>}
        {meta && <PluginMeta items={meta} />}
        {description && <p className={styles.description}>{description}</p>}
        {note}
      </div>
      <div className={styles['installed-actions']}>
        <span className={styles['switch-cell']} data-has-tools={tools ? true : undefined}>{control}</span>
        {tools && <div className="row-actions">{tools}</div>}
      </div>
    </article>
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
