import React from 'react';
import { App, Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { DATA_RETENTION_QUERY_KEY, formatRetentionDays, useDataRetention } from '../../hooks/useDataRetention';
import { SectionHeading } from '../common/SectionHeading';
import { SettingRow } from '../common/SettingRow';
import { useToast } from '../feedback';

/** The horizons offered; 0 keeps every record. */
const REQUEST_RECORD_PRESETS = [7, 14, 30, 60, 90, 180, 365, 0];

/** A value stored by other means (the environment, the API) stays selectable. */
function withCurrent(current: number): number[] {
  return REQUEST_RECORD_PRESETS.includes(current)
    ? REQUEST_RECORD_PRESETS
    : [...REQUEST_RECORD_PRESETS, current].sort((left, right) => (left === 0 ? 1 : right === 0 ? -1 : left - right));
}

/** Zero means "never", so a shorter horizon is any positive value below the old one. */
function isShorter(next: number, previous: number): boolean {
  return next > 0 && (previous === 0 || next < previous);
}

/**
 * DataRetentionSettings is how long request records are kept.
 *
 * Like the quota refresh policy it changes what the server does on its own: the maintenance loop
 * reads it on every pass. A pick is saved at once; shortening it asks first, because the records
 * past it are deleted for good. Captured payloads are an internal replay buffer with their own
 * short horizon and are not offered here. What the deletions have done is reported on the System
 * page, beside the database footprint.
 */
export const DataRetentionSettings: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const { modal } = App.useApp();
  const queryClient = useQueryClient();
  const { data } = useDataRetention();
  const save = useMutation({
    mutationFn: (next: { days: number; expected: number }) => api.setDataRetention(next.days, next.expected),
    onSuccess: (saved) => {
      queryClient.setQueryData(DATA_RETENTION_QUERY_KEY, saved);
      toast.success(t('omc.retention_saved'));
    },
    onError: (failure) => {
      // The horizon the operator confirmed is gone, so the deletion they confirmed is not the
      // one this console would make. Re-read and let them decide again.
      if (apiErrorCode(failure) === 'usage_retention_changed') {
        void queryClient.invalidateQueries({ queryKey: DATA_RETENTION_QUERY_KEY });
        toast.warning(t('omc.retention_changed'));
        return;
      }
      toast.error(t('omc.retention_save_failed', { msg: describeError(failure) }));
    },
  });

  const apply = (days: number) => {
    if (!data) return;
    const expected = data.request_record_days;
    if (!isShorter(days, expected)) {
      save.mutate({ days, expected });
      return;
    }
    modal.confirm({
      title: t('omc.retention_confirm_title'),
      content: t('omc.retention_confirm_records', { days }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => save.mutateAsync({ days, expected }),
    });
  };

  const current = data?.request_record_days ?? 0;
  return (
    <div className="settings-group omc-settings-group" data-testid="omc-retention-settings">
      <SectionHeading className="settings-group-head" title={t('omc.section_retention')} />
      <SettingRow
        label={t('omc.retention_records')}
        description={t('omc.retention_records_desc')}
        control={(
          <Select<number>
            value={data ? current : undefined}
            disabled={isDemoMode() || !data || save.isPending}
            options={withCurrent(current).map((days) => ({ value: days, label: formatRetentionDays(days, t) }))}
            onChange={apply}
            aria-label={t('omc.retention_records')}
            popupMatchSelectWidth={false}
          />
        )}
      />
    </div>
  );
};
