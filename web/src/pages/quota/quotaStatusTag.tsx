import React from 'react';

import type { TFunc } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { describeQuotaCooldown } from './quotaCooldown';
import { StatusLabel } from '../../components/common/StatusLabel';
import { Tooltip } from '../../components/common/Tooltip';

/**
 * The one status vocabulary for credential quota.
 *
 * The list row and the Drawer's quota tab both read it, so a credential cannot be
 * "Normal" in one place and something else in the other.
 */
export function quotaStatusTag(item: QuotaItem, t: TFunc): React.ReactNode {
  if (item.active_cooldown?.is_active || item.status === 'cooldown') {
    const reason = item.active_cooldown?.reason;
    return (
      <Tooltip title={describeQuotaCooldown(reason, t('quota.cooldown_active_desc'))}>
        <StatusLabel tone="danger">{t('quota.status_cooldown')}</StatusLabel>
      </Tooltip>
    );
  }
  if ((item.model_cooldowns?.length ?? 0) > 0 && ['healthy', 'idle', 'unpublished', 'warning'].includes(item.status)) {
    return <StatusLabel tone="warn">{t('quota.model_cooldown_status')}</StatusLabel>;
  }
  switch (item.status) {
    case 'healthy':
      return <StatusLabel tone="success">{t('quota.status_normal')}</StatusLabel>;
    case 'warning':
      return <StatusLabel tone="warn">{t('quota.status_warning')}</StatusLabel>;
    case 'exhausted':
      return <StatusLabel tone="danger">{t('quota.status_exceeded')}</StatusLabel>;
    case 'error':
      return <StatusLabel tone="danger">{t('quota.status_error')}</StatusLabel>;
    case 'stale':
      return <StatusLabel tone="neutral">{t('quota.status_stale')}</StatusLabel>;
    case 'unpublished':
      // Distinct from idle: the read happened, and the provider published no window. The two must
      // not share a label, because only one of them is worth repeating.
      return <StatusLabel tone="neutral">{t('quota.status_unpublished')}</StatusLabel>;
    case 'loading':
      return <StatusLabel tone="accent">{t('common.loading')}</StatusLabel>;
    default:
      return <StatusLabel tone="neutral">{t('quota.status_idle')}</StatusLabel>;
  }
}
