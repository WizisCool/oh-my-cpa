import React from 'react';
import { Button, Modal, Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useI18n, useT, LANGUAGES } from '../../i18n';
import { useExchangeRates } from '../../hooks/useExchangeRates';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import { EXCHANGE_RATES_QUERY_KEY, PRIMARY_CURRENCIES, formatCurrency } from '../../types/currencyDisplay';
import { isDemoMode } from '../../types/demoMode';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import dayjs from '../../utils/time';
import { SettingRow } from '../common/SettingRow';
import { Notice, useToast } from '../feedback';
import styles from './CurrencySettings.module.css';

export const CurrencySettings: React.FC = () => {
  useTimeZone();
  const t = useT();
  const { lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rates = useExchangeRates();
  const { currency, selectedCurrency, setCurrency, isLoaded } = useDisplayCurrency();
  const [isTableOpen, setIsTableOpen] = React.useState(false);
  const names = React.useMemo(() => new Intl.DisplayNames([LANGUAGES.find((entry) => entry.id === lang)!.locale], { type: 'currency' }), [lang]);
  const refresh = useMutation({
    mutationFn: api.refreshExchangeRates,
    onSuccess: (data) => {
      queryClient.setQueryData(EXCHANGE_RATES_QUERY_KEY, data);
      toast.success(t('omc.exchange_updated'));
    },
    onError: () => {
      toast.error(t('omc.exchange_update_failed'));
      void queryClient.invalidateQueries({ queryKey: EXCHANGE_RATES_QUERY_KEY });
    },
  });
  const options = React.useMemo(() => {
    const available = new Set(['USD', ...(rates.data?.rates.map((entry) => entry.currency) ?? [])]);
    const codes = [...new Set([...PRIMARY_CURRENCIES, selectedCurrency, ...available])];
    return codes.map((code) => ({ value: code, label: `${code} · ${names.of(code)}`, disabled: !available.has(code) }));
  }, [rates.data?.rates, selectedCurrency, names]);
  const updatedAt = rates.data?.updated_at_ms;
  const nextRefresh = rates.data?.next_refresh_at_ms;
  const hasRefreshError = rates.isError || Boolean(rates.data?.last_error);

  return <>
    <SettingRow
      label={t('omc.display_currency')}
      description={t('omc.display_currency_desc')}
      control={<Select
        className={styles['currency-select']}
        value={selectedCurrency}
        options={options}
        onChange={setCurrency}
        loading={rates.isPending}
        // A read that lands after a choice would replace the optimistic value in the shared
        // cache, so the choice waits for the stored document instead.
        disabled={!isLoaded}
        showSearch={{ optionFilterProp: 'label' }}
        aria-label={t('omc.display_currency')}
      />}
    />
    <SettingRow
      label={t('omc.exchange_rates')}
      description={updatedAt
        ? t('omc.exchange_schedule', { hours: rates.data!.refresh_interval_hours, time: dayjs(updatedAt).format('YYYY-MM-DD HH:mm') })
        : t('omc.exchange_empty')}
      control={<div className={styles['actions']}>
        <Button onClick={() => setIsTableOpen(true)}>{t('omc.exchange_table')}</Button>
        <Button loading={refresh.isPending} disabled={isDemoMode()} onClick={() => refresh.mutate()}>{t('omc.exchange_refresh')}</Button>
      </div>}
    />
    {(hasRefreshError || currency.rate === null) && <div className="settings-inline-notice">
      <Notice tone="warning" description={t(currency.rate === null ? 'omc.exchange_missing' : 'omc.exchange_cached')} />
    </div>}
    <Modal title={t('omc.exchange_table')} open={isTableOpen} onCancel={() => setIsTableOpen(false)} footer={null} width={640}>
      <p className={styles['source']}>
        {t('omc.exchange_source')}
        {nextRefresh ? <> · {t('omc.exchange_next', { time: dayjs(nextRefresh).format('YYYY-MM-DD HH:mm') })}</> : null}
      </p>
      <div className={styles['table-scroll']}>
        <table className={styles['rate-table']}>
          <thead><tr><th scope="col">{t('omc.display_currency')}</th><th scope="col">{t('omc.exchange_usd_rate')}</th><th scope="col">{t('omc.exchange_date')}</th></tr></thead>
          <tbody>
            <tr><th scope="row">USD · {names.of('USD')}</th><td>1</td><td>—</td></tr>
            {(rates.data?.rates ?? []).map((entry) => <tr key={entry.currency}>
              <th scope="row">{entry.currency} · {names.of(entry.currency)}</th>
              <td title={String(entry.rate)}>{entry.rate.toLocaleString('en', { maximumSignificantDigits: 10 })}</td>
              <td>{entry.date}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className={styles['source']}>{t('omc.exchange_preview', { value: formatCurrency(1, currency) })}</p>
    </Modal>
  </>;
};
