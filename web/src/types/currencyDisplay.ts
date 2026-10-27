import type { RollingReadout } from './rollingNumber';

export interface ExchangeRate {
  currency: string;
  rate: number;
  date: string;
}

export interface ExchangeRates {
  base_currency: 'USD';
  source: 'frankfurter_v2';
  refresh_interval_hours: number;
  rates: ExchangeRate[];
  updated_at_ms: number;
  attempted_at_ms: number;
  next_refresh_at_ms: number;
  last_error: string;
}

export interface DisplayCurrency {
  code: string;
  /** Missing rates have no reading; an unavailable conversion must never look like USD at 1:1. */
  rate: number | null;
}

export const DISPLAY_CURRENCY_PREFERENCE = 'omc_display_currency';
export const USD_CURRENCY: DisplayCurrency = { code: 'USD', rate: 1 };
export const EXCHANGE_RATES_QUERY_KEY = ['exchange-rates'] as const;
export const PRIMARY_CURRENCIES = ['USD', 'CNY', 'MYR', 'JPY', 'EUR', 'GBP', 'SGD', 'HKD', 'AUD', 'CAD', 'CHF', 'KRW', 'TWD', 'THB', 'IDR', 'INR', 'NZD'] as const;

export function parseDisplayCurrency(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Z]{3}$/.test(raw) ? raw : undefined;
}

export function resolveDisplayCurrency(code: string, rates: readonly ExchangeRate[]): DisplayCurrency {
  if (code === 'USD') return USD_CURRENCY;
  const rate = rates.find((entry) => entry.currency === code)?.rate;
  return { code, rate: rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : null };
}

type MoneyPrecision = number | 'adaptive' | 'amount' | 'rate';
const FORMATTERS = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: DisplayCurrency, amount: number, precision: MoneyPrecision): Intl.NumberFormat {
  const magnitude = Math.abs(amount);
  const digits = precision === 'adaptive' ? (amount !== 0 && magnitude < 0.01 ? 4 : 2)
    : precision === 'rate' ? 6
    : precision === 'amount' ? (magnitude === 0 || magnitude >= 1 ? 2 : magnitude >= 0.01 ? 4 : 6)
    : precision;
  const minDigits = precision === 'rate' || precision === 'amount' ? 2 : digits;
  const useGrouping = precision === 'amount' && magnitude >= 100;
  const key = `${currency.code}:${minDigits}:${digits}:${useGrouping}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en', { style: 'currency', currency: currency.code, minimumFractionDigits: minDigits, maximumFractionDigits: digits, useGrouping });
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

function convertUsd(usd: number | null | undefined, currency: DisplayCurrency): number | null {
  if (usd == null || !Number.isFinite(usd) || currency.rate === null) return null;
  if (!Number.isFinite(currency.rate) || currency.rate <= 0) return null;
  const amount = usd * currency.rate;
  return Number.isFinite(amount) ? amount : null;
}

/** Conversion is presentation-only: callers keep using the original USD values for math and APIs. */
export function formatCurrency(usd: number | null | undefined, currency = USD_CURRENCY, precision: MoneyPrecision = 4): string {
  const amount = convertUsd(usd, currency);
  return amount === null ? '—' : moneyFormatter(currency, amount, precision).format(amount);
}

/** Derive both moving digits and surrounding currency marks from the same formatter as static copy. */
export function currencyReadout(usd: number | null | undefined, currency = USD_CURRENCY, precision: MoneyPrecision = 2): RollingReadout | undefined {
  const amount = convertUsd(usd, currency);
  if (amount === null) return undefined;
  const formatter = moneyFormatter(currency, amount, precision);
  let prefix = '';
  let suffix = '';
  let hasNumber = false;
  for (const part of formatter.formatToParts(amount)) {
    if (['integer', 'decimal', 'fraction', 'group'].includes(part.type)) hasNumber = true;
    else if (hasNumber) suffix += part.value;
    else prefix += part.value;
  }
  const options = formatter.resolvedOptions();
  return { number: Math.abs(amount), prefix, suffix, format: { minimumFractionDigits: options.minimumFractionDigits, maximumFractionDigits: options.maximumFractionDigits, useGrouping: options.useGrouping } };
}
