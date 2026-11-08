import React from 'react';

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  HourglassOutlined,
  WarningOutlined,
} from '../../components/icons';
import type { TFunc } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { describeQuotaCooldown } from './quotaCooldown';
import { Tag } from '../../components/common/Tag';
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
        {/* Cooling down is a wait the credential comes back from on its own clock; the dashboard's
            quota row draws the same hourglass. */}
        <Tag tone="danger" icon={<HourglassOutlined />}>{t('quota.status_cooldown')}</Tag>
      </Tooltip>
    );
  }
  if ((item.model_cooldowns?.length ?? 0) > 0 && ['healthy', 'idle', 'unpublished', 'warning'].includes(item.status)) {
    return <Tag tone="warn" icon={<HourglassOutlined />}>{t('quota.model_cooldown_status')}</Tag>;
  }
  switch (item.status) {
    case 'healthy':
      return <Tag tone="success" icon={<CheckCircleOutlined />}>{t('quota.status_normal')}</Tag>;
    case 'warning':
      return <Tag tone="warn" icon={<WarningOutlined />}>{t('quota.status_warning')}</Tag>;
    case 'exhausted':
      return <Tag tone="danger" icon={<CloseCircleOutlined />}>{t('quota.status_exceeded')}</Tag>;
    case 'error':
      return <Tag tone="danger">{t('quota.status_error')}</Tag>;
    case 'stale':
      return <Tag>{t('quota.status_stale')}</Tag>;
    case 'unpublished':
      // Distinct from idle: the read happened, and the provider published no window. The two must
      // not share a label, because only one of them is worth repeating.
      return <Tag>{t('quota.status_unpublished')}</Tag>;
    case 'loading':
      return <Tag tone="accent">{t('common.loading')}</Tag>;
    default:
      return <Tag>{t('quota.status_idle')}</Tag>;
  }
}
