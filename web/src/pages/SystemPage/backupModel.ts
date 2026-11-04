import type {
  BackupAutomation,
  BackupAutomationInput,
  BackupDestination,
  DatabaseBackupJob,
} from '../../types/databaseBackup';

export const STATE_KEYS = {
  queued: 'sys.backup_state_queued',
  snapshotting: 'sys.backup_state_snapshotting',
  packaging: 'sys.backup_state_packaging',
  validating: 'sys.backup_state_validating',
  uploading: 'sys.backup_state_uploading',
  ready: 'sys.backup_state_ready',
  scheduled: 'sys.backup_state_scheduled',
  completed: 'sys.backup_state_completed',
  failed: 'sys.backup_state_failed',
} as const satisfies Record<DatabaseBackupJob['state'], string>;

export const RUNNING_STATES = new Set<DatabaseBackupJob['state']>([
  'queued',
  'snapshotting',
  'packaging',
  'validating',
  'uploading',
]);

/** Retention choices for one location; the server accepts 1-100. */
export const KEEP_COUNTS = [3, 7, 14, 30, 60, 100];
/** What local retention returns to when the disk is switched back on. */
export const DEFAULT_KEEP_LOCAL = 7;
export const MAX_DESTINATIONS = 8;
export const MIN_PASSPHRASE_LENGTH = 12;

/** A passphrase is counted in characters, as the server counts it, not in UTF-16 units. */
export const isPassphraseLongEnough = (value: string) =>
  [...value].length >= MIN_PASSPHRASE_LENGTH && value.length <= 1024;

/** The saved settings as a write: the server keeps each destination's credentials it already holds. */
export function automationInput(value: BackupAutomation): BackupAutomationInput {
  return {
    enabled: value.enabled,
    daily_at_minute: value.daily_at_minute,
    keep_local: value.keep_local,
    keep_remote: value.keep_remote,
    destinations: value.destinations.map(destinationInput),
  };
}

export function destinationInput({ id, name, provider, root }: BackupDestination) {
  return { id, name, provider, root };
}
