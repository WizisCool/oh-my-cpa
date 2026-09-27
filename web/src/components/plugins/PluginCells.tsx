import { Tag } from 'antd';
import { ApiOutlined } from '../icons';
import styles from './PluginCells.module.css';

/** The name a plugin is called by in the console: its declared name, then its manifest's, then its id. */
export function pluginDisplayName(plugin: { id: string; name?: string; metadata?: { name?: string } }): string {
  return plugin.name?.trim() || plugin.metadata?.name?.trim() || plugin.id;
}

interface PluginIdentityProps {
  name: string;
  id: string;
  description?: string;
}

/**
 * A plugin's headline: its name, its id, and the one-line description it declares.
 *
 * The installed list and the store read the same three facts, so they are one cell - a plugin
 * cannot look different in the store from how it looks once installed.
 */
export function PluginIdentity({ name, id, description }: PluginIdentityProps) {
  // A plugin that declares no name is still identified - by its id, which is then the headline
  // rather than printed twice.
  const headline = name.trim() || id;
  return (
    <div className={styles['plugin-identity']}>
      <div className={styles['plugin-name']}>
        <ApiOutlined />
        <span>{headline}</span>
      </div>
      {headline !== id && <div className={styles['plugin-id']}>{id}</div>}
      {description && <div className={styles['plugin-description']}>{description}</div>}
    </div>
  );
}

interface PluginVersionProps {
  version?: string;
  author?: string;
}

/**
 * The version a plugin declares, and its author.
 *
 * A plugin that declares no version shows an em dash: printing a made-up `v1.0.0` would claim
 * a release the plugin never stated.
 */
export function PluginVersion({ version, author }: PluginVersionProps) {
  return (
    <div className={styles['plugin-version']}>
      {version ? <span className={styles['version-chip']}>{version}</span> : <span className={styles['plugin-muted']}>—</span>}
      {author && <div className={styles['plugin-author']}>{author}</div>}
    </div>
  );
}

interface PluginPermissionsProps {
  permissions?: readonly string[];
  /** The store asks for these; an installed plugin already holds them. Only a request is a warning. */
  isRequest?: boolean;
}

export function PluginPermissions({ permissions, isRequest = false }: PluginPermissionsProps) {
  if (!permissions || permissions.length === 0) return <span className={styles['plugin-muted']}>—</span>;
  return (
    <div className={styles['plugin-permissions']}>
      {permissions.map((permission) => (
        <Tag key={permission} color={isRequest ? 'warning' : undefined} className={styles['permission-tag']}>
          {permission}
        </Tag>
      ))}
    </div>
  );
}
