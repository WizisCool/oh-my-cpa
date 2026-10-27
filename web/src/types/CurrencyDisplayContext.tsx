import React from 'react';
import { usePreference } from '../hooks/usePreference';
import { useExchangeRates } from '../hooks/useExchangeRates';
import { DISPLAY_CURRENCY_PREFERENCE, USD_CURRENCY, parseDisplayCurrency, resolveDisplayCurrency, type DisplayCurrency } from './currencyDisplay';

interface CurrencyDisplayValue {
  currency: DisplayCurrency;
  selectedCurrency: string;
  setCurrency: (code: string) => void;
}
const CurrencyDisplayContext = React.createContext<CurrencyDisplayValue>({ currency: USD_CURRENCY, selectedCurrency: 'USD', setCurrency: () => undefined });

export const CurrencyDisplayProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const preference = usePreference(DISPLAY_CURRENCY_PREFERENCE, 'USD', parseDisplayCurrency);
  const rates = useExchangeRates(preference.value !== 'USD');
  const currency = React.useMemo(() => resolveDisplayCurrency(preference.value, rates.data?.rates ?? []), [preference.value, rates.data?.rates]);
  const value = React.useMemo(() => ({ currency, selectedCurrency: preference.value, setCurrency: preference.set }), [currency, preference.value, preference.set]);
  return <CurrencyDisplayContext.Provider value={value}>{children}</CurrencyDisplayContext.Provider>;
};

export function useDisplayCurrency() { return React.useContext(CurrencyDisplayContext); }
