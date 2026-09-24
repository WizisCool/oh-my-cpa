import React from 'react';
import { Tag } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { TFunc } from '../../i18n';
import type { QuotaItem } from '../../types/quota';

/**
 * The one status vocabulary for credential quota.
 *
 * The list row and the Drawer's quota tab both read it, so a credential cannot be
 * "Normal" in one place and something else in the other.
 */
export function quotaStatusTag(item: QuotaItem, t: TFunc): React.ReactNode {
  if (item.active_cooldown?.is_active || item.status === 'cooldown') {
    return <Tag color="error" icon={<StopOutlined />} style={{ margin: 0 }}>{t('quota.status_cooldown')}</Tag>;
  }
  switch (item.status) {
    case 'healthy':
      return <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>{t('quota.status_normal')}</Tag>;
    case 'warning':
      return <Tag color="warning" icon={<WarningOutlined />} style={{ margin: 0 }}>{t('quota.status_warning')}</Tag>;
    case 'exhausted':
      return <Tag color="error" icon={<CloseCircleOutlined />} style={{ margin: 0 }}>{t('quota.status_exceeded')}</Tag>;
    case 'error':
      return <Tag color="error" style={{ margin: 0 }}>{t('quota.status_error')}</Tag>;
    case 'stale':
      return <Tag style={{ margin: 0 }}>{t('quota.status_stale')}</Tag>;
    case 'loading':
      return <Tag color="processing" style={{ margin: 0 }}>{t('common.loading')}</Tag>;
    default:
      return <Tag style={{ margin: 0 }}>{t('quota.status_idle')}</Tag>;
  }
}
