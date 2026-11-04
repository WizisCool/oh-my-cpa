import React from 'react';
import { CloudServerOutlined, DatabaseOutlined, GlobalOutlined, CodeOutlined, BoxOutlined } from '../../components/icons';
import type { BackupProvider } from '../../types/databaseBackup';
import { storageMarkURL, type StorageMark } from '../../assets/brand/storageMarks';
import styles from './DatabaseBackups.module.css';

/**
 * A storage location's mark.
 *
 * Account-based services show their own published mark, copied into the bundle from the SVG Logos
 * collection (CC0) and Simple Icons (CC0), so OneDrive, Google Drive and S3 are recognised before
 * their name is read. The protocol services have no product mark - they are formats, not brands -
 * so they take the icon set's glyph for what they are. Nothing is drawn here by hand.
 */
const BRAND_MARKS: Partial<Record<BackupProvider, StorageMark>> = {
  onedrive: 'onedrive',
  drive: 'drive',
  s3: 's3',
};

const SERVICE_GLYPHS: Record<'webdav' | 'sftp' | 'smb' | 'ftp' | 'local', React.ReactNode> = {
  local: <DatabaseOutlined />,
  webdav: <GlobalOutlined />,
  sftp: <CodeOutlined />,
  smb: <BoxOutlined />,
  ftp: <CloudServerOutlined />,
};

export function BackupProviderMark({
  provider,
  size = 36,
}: {
  provider: BackupProvider | 'local';
  size?: number;
}) {
  const slug = provider === 'local' ? undefined : BRAND_MARKS[provider];
  return (
    <span className={styles['mark']} data-provider={provider} style={{ width: size, height: size }} aria-hidden>
      {slug ? (
        <img
          className={styles['mark-image']}
          src={storageMarkURL(slug)}
          alt=""
          width={Math.round(size * 0.6)}
          height={Math.round(size * 0.6)}
          loading="eager"
          decoding="async"
        />
      ) : (
        <span className={styles['mark-glyph']} style={{ fontSize: Math.round(size * 0.5) }}>
          {SERVICE_GLYPHS[provider as keyof typeof SERVICE_GLYPHS]}
        </span>
      )}
    </span>
  );
}
