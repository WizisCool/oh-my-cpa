import type { MessageKey } from '../i18n/catalog';

const ERROR_KEYS = {
  database_backup_oauth: 'sys.backup_oauth_error',
  database_backup_version: 'sys.backup_error_version',
  database_backup_busy: 'sys.backup_error_busy',
  database_backup_confirmation: 'sys.backup_error_confirmation',
  database_backup_passphrase: 'sys.backup_error_passphrase',
  database_backup_invalid: 'sys.backup_error_invalid',
  database_backup_audit: 'sys.backup_error_audit',
  database_backup_disk_space: 'sys.backup_error_disk_space',
  database_backup_proxy_unsupported: 'sys.backup_error_proxy_unsupported',
} as const satisfies Record<string, MessageKey>;

export function databaseBackupErrorKey(code: string, fallback: MessageKey): MessageKey {
  return Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : fallback;
}
