import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '@/components/ui/select';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { usePreference } from '../../hooks/usePreference';
import { invalidateSwrScopes } from '../../performance/swrContract';
import { PRICING_QUERY_KEYS } from '../pricing/pricingQueries';
import {
  DEFAULT_UPDATE_CHECK,
  UPDATE_CHECK_INTERVALS,
  UPDATE_CHECK_PREFERENCE,
  parseUpdateCheck,
  type UpdateCheckSettings,
} from '../../types/updateCheck';
import {
  DEFAULT_QUOTA_AUTO_REFRESH,
  QUOTA_AUTO_REFRESH_INTERVALS,
  QUOTA_AUTO_REFRESH_PREFERENCE,
  parseQuotaAutoRefresh,
  type QuotaAutoRefreshSettings,
} from '../../types/quotaAutoRefresh';
import {
  DEFAULT_EXCHANGE_RATE_REFRESH,
  EXCHANGE_RATE_REFRESH_INTERVALS,
  EXCHANGE_RATE_REFRESH_PREFERENCE,
  parseExchangeRateRefresh,
  type ExchangeRateRefreshSettings,
} from '../../types/exchangeRateRefresh';
import { SettingsGroup } from './SettingsGroup';
import { SettingRow } from '../common/SettingRow';
import { Switch } from '../common/Switch';
import { LoadFailure, useToast } from '../feedback';

export const PRICING_SYNC_INTERVAL_PRESETS = [0, 1, 6, 12, 24, 72, 168] as const;

function withCurrentInterval(presets: readonly number[], current: number): number[] {
  if (presets.includes(current)) return [...presets];
  return [...presets, current].sort((left, right) => left - right);
}

/**
 * AutoRefreshSettings consolidates every scheduled background refresh and update check
 * into one OMC Settings group: OMC/CPA release checks, plugin store update checks,
 * credential quota refresh, OpenRouter pricing sync, and display exchange-rate refresh.
 */
export const AutoRefreshSettings: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const updatePref = usePreference<UpdateCheckSettings>(
    UPDATE_CHECK_PREFERENCE,
    DEFAULT_UPDATE_CHECK,
    parseUpdateCheck,
  );
  const quotaPref = usePreference<QuotaAutoRefreshSettings>(
    QUOTA_AUTO_REFRESH_PREFERENCE,
    DEFAULT_QUOTA_AUTO_REFRESH,
    parseQuotaAutoRefresh,
  );
  const exchangeRatePref = usePreference<ExchangeRateRefreshSettings>(
    EXCHANGE_RATE_REFRESH_PREFERENCE,
    DEFAULT_EXCHANGE_RATE_REFRESH,
    parseExchangeRateRefresh,
  );

  const pricingScheduleQuery = useQuery({
    queryKey: PRICING_QUERY_KEYS.syncSchedule,
    queryFn: api.getPricingSyncSchedule,
    staleTime: 30_000,
  });

  const pricingScheduleMutation = useMutation({
    mutationFn: (intervalHours: number) => api.updatePricingSyncSchedule(intervalHours),
    onSuccess: (saved) => {
      queryClient.setQueryData(PRICING_QUERY_KEYS.syncSchedule, saved);
      void invalidateSwrScopes(queryClient, 'pricing');
      toast.success(t('pricing.sync.schedule_updated'));
    },
    onError: (error) => {
      toast.error(describeError(error));
    },
  });

  const formatMinutes = (minutes: number) => {
    if (minutes === 0) return t('omc.auto_refresh_off');
    return minutes % 60 === 0
      ? t('omc.auto_refresh_hours', { n: minutes / 60 })
      : t('omc.auto_refresh_minutes', { n: minutes });
  };

  const formatHours = (hours: number) => {
    if (hours === 0) return t('omc.auto_refresh_off');
    if (hours >= 48 && hours % 24 === 0) {
      return t('omc.auto_refresh_days', { n: hours / 24 });
    }
    return t('omc.auto_refresh_hours', { n: hours });
  };

  const updateSettings = updatePref.value;
  const quotaSettings = quotaPref.value;
  const exchangeRateSettings = exchangeRatePref.value;
  const pricingHours = pricingScheduleQuery.data?.interval_hours ?? 24;

  const releaseIntervals = withCurrentInterval(UPDATE_CHECK_INTERVALS, updateSettings.interval_minutes);
  const pluginIntervals = withCurrentInterval(UPDATE_CHECK_INTERVALS, updateSettings.plugin_interval_minutes);
  const quotaIntervals = withCurrentInterval(QUOTA_AUTO_REFRESH_INTERVALS, quotaSettings.interval_minutes);
  const pricingIntervals = withCurrentInterval(PRICING_SYNC_INTERVAL_PRESETS, pricingHours);
  const exchangeIntervals = withCurrentInterval(EXCHANGE_RATE_REFRESH_INTERVALS, exchangeRateSettings.interval_hours);

  return (
    <SettingsGroup id="auto-refresh" title={t('omc.section_auto_refresh')} testId="omc-auto-refresh-settings">
      <SettingRow
        label={t('omc.release_check_interval')}
        description={t('omc.release_check_interval_desc')}
        control={(
          <Select<number>
            value={updateSettings.interval_minutes}
            disabled={!updatePref.loaded}
            options={releaseIntervals.map((minutes) => ({ value: minutes, label: formatMinutes(minutes) }))}
            onChange={(minutes) => {
              void updatePref.set({ ...updateSettings, interval_minutes: minutes });
            }}
            aria-label={t('omc.release_check_interval')}
            popupMatchSelectWidth={false}
          />
        )}
      />
      <SettingRow
        label={t('omc.plugin_check_interval')}
        description={t('omc.plugin_check_interval_desc')}
        control={(
          <Select<number>
            value={updateSettings.plugin_interval_minutes}
            disabled={!updatePref.loaded}
            options={pluginIntervals.map((minutes) => ({ value: minutes, label: formatMinutes(minutes) }))}
            onChange={(minutes) => {
              void updatePref.set({ ...updateSettings, plugin_interval_minutes: minutes });
            }}
            aria-label={t('omc.plugin_check_interval')}
            popupMatchSelectWidth={false}
          />
        )}
      />
      <SettingRow
        label={t('omc.quota_auto_refresh_interval')}
        description={t('omc.quota_auto_refresh_interval_desc')}
        control={(
          <Select<number>
            value={quotaSettings.interval_minutes}
            disabled={!quotaPref.loaded}
            options={quotaIntervals.map((minutes) => ({ value: minutes, label: formatMinutes(minutes) }))}
            onChange={(minutes) => {
              void quotaPref.set({ ...quotaSettings, interval_minutes: minutes });
            }}
            aria-label={t('omc.quota_auto_refresh_interval')}
            popupMatchSelectWidth={false}
          />
        )}
      />
      <SettingRow
        label={t('omc.quota_refresh_on_reset')}
        description={t('omc.quota_refresh_on_reset_desc')}
        control={(
          <Switch
            checked={quotaSettings.refresh_on_reset}
            disabled={!quotaPref.loaded}
            onChange={(checked) => {
              void quotaPref.set({ ...quotaSettings, refresh_on_reset: checked });
            }}
            aria-label={t('omc.quota_refresh_on_reset')}
          />
        )}
      />
      <SettingRow
        label={t('omc.pricing_auto_sync_interval')}
        description={t('omc.pricing_auto_sync_interval_desc')}
        control={(
          <Select<number>
            value={pricingScheduleQuery.data ? pricingHours : undefined}
            disabled={!pricingScheduleQuery.data || pricingScheduleMutation.isPending}
            options={pricingIntervals.map((hours) => ({ value: hours, label: formatHours(hours) }))}
            onChange={(hours) => pricingScheduleMutation.mutate(hours)}
            aria-label={t('omc.pricing_auto_sync_interval')}
            popupMatchSelectWidth={false}
          />
        )}
      />
      {pricingScheduleQuery.isError && !pricingScheduleQuery.data && (
        <div className="settings-inline-notice">
          <LoadFailure
            title={t('common.load_failed_title')}
            error={pricingScheduleQuery.error}
            onRetry={() => { void pricingScheduleQuery.refetch(); }}
          />
        </div>
      )}
      <SettingRow
        label={t('omc.exchange_rate_refresh_interval')}
        description={t('omc.exchange_rate_refresh_interval_desc')}
        control={(
          <Select<number>
            value={exchangeRateSettings.interval_hours}
            disabled={!exchangeRatePref.loaded}
            options={exchangeIntervals.map((hours) => ({ value: hours, label: formatHours(hours) }))}
            onChange={(hours) => {
              void exchangeRatePref.set({ interval_hours: hours });
            }}
            aria-label={t('omc.exchange_rate_refresh_interval')}
            popupMatchSelectWidth={false}
          />
        )}
      />
    </SettingsGroup>
  );
};
