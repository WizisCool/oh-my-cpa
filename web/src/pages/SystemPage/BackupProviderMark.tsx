import type { BackupProvider } from '../../types/databaseBackup';
import React from 'react';
import styles from './DatabaseBackups.module.css';

/**
 * A storage location's mark: a tinted tile with a glyph that says which kind of place it is.
 *
 * The provider list is scanned, not read - "OneDrive" and "S3" must be told apart before the
 * name is parsed - so each provider gets its own shape and its own tint. The two account-based
 * drives use their real mark shape; the protocol services use a glyph of what they are.
 */
export function BackupProviderMark({
  provider,
  size = 36,
}: {
  provider: BackupProvider | 'local';
  size?: number;
}) {
  return (
    <span
      className={styles['mark']}
      data-provider={provider}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="none" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        {MARKS[provider]}
      </svg>
    </span>
  );
}

const MARKS: Record<BackupProvider | 'local', React.ReactNode> = {
  local: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" stroke="currentColor" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" stroke="currentColor" />
      <path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" />
    </>
  ),
  onedrive: (
    <path d="M7 18.5a4.2 4.2 0 0 1-.6-8.35 5.6 5.6 0 0 1 10.7-1.3A4.6 4.6 0 0 1 17.5 18.5z" stroke="currentColor" />
  ),
  drive: (
    <>
      <path d="M12 3.5 3.8 17.8" stroke="#0F9D58" />
      <path d="M12 3.5 20.2 17.8" stroke="#4285F4" />
      <path d="M3.8 17.8h16.4" stroke="#F4B400" />
      <path d="M12 3.5v0" stroke="currentColor" />
    </>
  ),
  s3: (
    <>
      <path d="M4.5 7.5 12 4l7.5 3.5v9L12 20l-7.5-3.5z" stroke="currentColor" />
      <path d="M4.5 7.5 12 11l7.5-3.5M12 11v9" stroke="currentColor" />
    </>
  ),
  webdav: (
    <>
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" />
      <path d="M3.8 12h16.4M12 3.8c2.3 2.3 3.5 5.1 3.5 8.2S14.3 17.9 12 20.2C9.7 17.9 8.5 15.1 8.5 12S9.7 6.1 12 3.8" stroke="currentColor" />
    </>
  ),
  sftp: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" />
      <path d="m7.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5h4" stroke="currentColor" />
    </>
  ),
  smb: (
    <>
      <path d="M3.5 8.2V6.8c0-.7.6-1.3 1.3-1.3h4l1.7 2h8.7c.7 0 1.3.6 1.3 1.3v10.4c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3z" stroke="currentColor" />
      <path d="M12 11.5v5M9.5 14h5" stroke="currentColor" />
    </>
  ),
  ftp: (
    <>
      <path d="M3.5 8.2V6.8c0-.7.6-1.3 1.3-1.3h4l1.7 2h8.7c.7 0 1.3.6 1.3 1.3v10.4c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3z" stroke="currentColor" />
      <path d="M8.5 13.5h7M13 11l2.5 2.5L13 16" stroke="currentColor" />
    </>
  ),
};
