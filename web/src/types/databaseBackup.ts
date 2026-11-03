export interface DatabaseBackupJob {
  id: string;
  kind: 'export' | 'import' | 'automatic';
  state:
    | 'queued'
    | 'snapshotting'
    | 'packaging'
    | 'validating'
    | 'uploading'
    | 'ready'
    | 'scheduled'
    | 'completed'
    | 'failed';
  created_at_ms: number;
  expires_at_ms: number;
  size_bytes: number;
  digest: string;
  source_version: string;
  source_schema_version: number;
  backup_created_at_ms: number;
  error?: string;
  has_audit_error: boolean;
}

export interface DatabaseBackupsResponse {
  items: DatabaseBackupJob[];
}

export type BackupProvider = 's3' | 'webdav' | 'sftp' | 'smb' | 'ftp' | 'drive' | 'onedrive';
export interface BackupDestination {
  id: string;
  name: string;
  provider: BackupProvider;
  root: string;
  has_config: boolean;
}
export interface BackupAutomation {
  enabled: boolean;
  /** The local time of day the daily run starts, in minutes from midnight. */
  daily_at_minute: number;
  keep_local: number;
  keep_remote: number;
  has_passphrase: boolean;
  destinations: BackupDestination[];
  next_run_at_ms: number;
  last_run_at_ms: number;
  last_success_at_ms: number;
  last_error: string;
}
export interface BackupAutomationInput {
  enabled: boolean;
  /** The local time of day the daily run starts, in minutes from midnight. */
  daily_at_minute: number;
  keep_local: number;
  keep_remote: number;
  passphrase?: string;
  destinations: Array<
    Omit<BackupDestination, 'has_config'> & {
      options?: Record<string, string>;
      authorization_id?: string;
    }
  >;
}
export interface BackupArchive {
  key: string;
  size_bytes: number;
  created_at_ms: number;
}

export interface BackupAuthorization {
  id: string;
  authorization_url?: string;
  expires_at_ms: number;
  status: 'waiting' | 'connected' | 'denied';
}
