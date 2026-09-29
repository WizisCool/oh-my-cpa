import { ApiError, apiErrorCode } from '../../api/client';

/**
 * The sentence a refused configuration save shows, from the dictionary where the
 * server's refusal has a code. A revision conflict is not described here: each
 * editor answers it with its own dialog.
 */
export function describeConfigSaveError(
  err: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const code = apiErrorCode(err);
  switch (code) {
    case 'write_busy':
      // A configuration save shares the provider write gate, so it can be refused
      // while a provider change is being written.
      return t('cfg.save_busy');
    case 'config_rejected': {
      // CPA's own reason names the offending path; it is quoted, not translated.
      const reason = err instanceof ApiError ? (err.data as { reason?: unknown } | null)?.reason : undefined;
      return t('cfg.save_rejected', { reason: typeof reason === 'string' ? reason : '' });
    }
    case 'config_backup_failed':
      return t('cfg.save_backup_failed');
    case 'config_partially_applied':
      // Part of the change set landed, so the editor's baseline is stale and its
      // next save meets the revision conflict dialog, which reloads onto it.
      return t('cfg.save_partially_applied');
    case 'config_sentinel_unrestorable':
      return t('cfg.save_sentinel_unrestorable');
    default:
      return err instanceof ApiError ? err.message : String(err);
  }
}
