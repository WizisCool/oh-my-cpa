import React from 'react';
import { Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useI18n, useT, LANGUAGES } from '../../i18n';
import { useExchangeRates } from '../../hooks/useExchangeRates';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import { DISPLAY_CURRENCIES, EXCHANGE_RATES_QUERY_KEY, currencySymbol, formatCurrency, type DisplayCurrencyCode } from '../../types/currencyDisplay';
import { isDemoMode } from '../../types/demoMode';
import { CountryFlag } from '../common/CountryFlag';
import { RefreshButton } from '../common/RefreshButton';
import { SettingRow } from '../common/SettingRow';
import { Notice, useToast } from '../feedback';
import { CURRENCY_FLAGS } from './currencyFlags';
import styles from './CurrencySettings.module.css';

export const CurrencySettings: React.FC = () => {
  const t = useT();
  const { lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rates = useExchangeRates();
  const { currency, selectedCurrency, setCurrency, isLoaded } = useDisplayCurrency();
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
    const available = new Set<string>(['USD', ...(rates.data?.rates.map((entry) => entry.currency) ?? [])]);
    return DISPLAY_CURRENCIES.map((code) => ({ value: code, label: `${code} · ${names.of(code)}`, name: names.of(code) ?? code, disabled: !available.has(code) }));
  }, [rates.data?.rates, names]);
  const updatedAt = rates.data?.updated_at_ms;
  const hasRefreshError = rates.isError || Boolean(rates.data?.last_error);
  // Only a converted reading needs its rate stated; USD is the accounting unit itself. The date is
  // the quote's own observation day, which can trail the download.
  const quoteDate = rates.data?.rates.find((entry) => entry.currency === currency.code)?.date;
  const status = !updatedAt ? t('omc.exchange_empty')
    : currency.code !== 'USD' && currency.rate !== null && quoteDate
      ? t('omc.exchange_rate', { value: formatCurrency(1, currency, 'rate'), date: quoteDate })
      : undefined;
  const renderCurrency = (code: DisplayCurrencyCode, name: string) => <span className={styles['currency-option']}>
    <CountryFlag markup={CURRENCY_FLAGS[code]} />
    <span className={styles['currency-code']}>{code}</span>
    <span className={styles['currency-name']}>{name}</span>
    <span className={styles['currency-symbol']}>{currencySymbol(code)}</span>
  </span>;

  return <>
    <SettingRow
      label={t('omc.display_currency')}
      description={<>{t('omc.display_currency_desc')}{status && <span className={styles['status']}>{status}</span>}</>}
      control={<div className={styles['control']}>
        <Select
          className={styles['currency-select']}
          classNames={{ popup: { root: styles['currency-popup'] } }}
          popupMatchSelectWidth={false}
          value={selectedCurrency}
          options={options}
          onChange={setCurrency}
          loading={rates.isPending}
          // A read that lands after a choice would replace the optimistic value in the shared
          // cache, so the choice waits for the stored document instead.
          disabled={!isLoaded}
          showSearch={{ optionFilterProp: 'label' }}
          listHeight={360}
          aria-label={t('omc.display_currency')}
          labelRender={({ value }) => renderCurrency(value as DisplayCurrencyCode, names.of(String(value)) ?? String(value))}
          optionRender={(option) => renderCurrency(option.value as DisplayCurrencyCode, option.data.name)}
        />
        <RefreshButton
          label={t('omc.exchange_refresh')}
          isRefreshing={refresh.isPending}
          disabled={isDemoMode() || refresh.isPending}
          onRefresh={() => refresh.mutate()}
        />
      </div>}
    />
    {(hasRefreshError || currency.rate === null) && <div className="settings-inline-notice">
      <Notice tone="warning" description={t(currency.rate === null ? 'omc.exchange_missing' : 'omc.exchange_cached')} />
    </div>}
  </>;
};
