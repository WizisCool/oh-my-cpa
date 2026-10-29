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
  code: DisplayCurrencyCode;
  /** Missing rates have no reading; an unavailable conversion must never look like USD at 1:1. */
  rate: number | null;
}

export const DISPLAY_CURRENCY_PREFERENCE = 'omc_display_currency';
export const USD_CURRENCY: DisplayCurrency = { code: 'USD', rate: 1 };
export const EXCHANGE_RATES_QUERY_KEY = ['exchange-rates'] as const;
/** Mirrors `exchangerate.DISPLAY_CURRENCIES`: the server accepts and caches only these. */
export const DISPLAY_CURRENCIES = ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'MYR', 'KRW', 'AUD', 'CAD'] as const;
export type DisplayCurrencyCode = typeof DISPLAY_CURRENCIES[number];

/**
 * Every amount reads as one mark flush against the number. Intl's English symbols mix bare codes
 * (`MYR 1.00`) with regional marks (`CN¥`), so each currency carries the mark its own market
 * prints, with the dollar family kept apart.
 */
const CURRENCY_SYMBOLS: Readonly<Record<DisplayCurrencyCode, string>> = {
  USD: '$', CNY: '¥', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$', SGD: 'S$', MYR: 'RM', KRW: '₩', AUD: 'A$', CAD: 'C$',
};

export function isDisplayCurrency(raw: unknown): raw is DisplayCurrencyCode {
  return DISPLAY_CURRENCIES.includes(raw as DisplayCurrencyCode);
}

export function parseDisplayCurrency(raw: unknown): DisplayCurrencyCode | undefined {
  return isDisplayCurrency(raw) ? raw : undefined;
}

export function currencySymbol(code: DisplayCurrencyCode): string {
  return CURRENCY_SYMBOLS[code];
}

export function resolveDisplayCurrency(code: DisplayCurrencyCode, rates: readonly ExchangeRate[]): DisplayCurrency {
  if (code === 'USD') return USD_CURRENCY;
  const rate = rates.find((entry) => entry.currency === code)?.rate;
  return { code, rate: rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : null };
}

/** Rates are not amounts; every other reading is money. */
type MoneyPrecision = 'money' | 'rate';
const FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Money reads at two decimals. A fraction of a cent keeps four, and one below a
 * ten-thousandth six — the finest reading the console prints. A rate keeps six decimals:
 * a per-1M price and the 1-USD quote are readings, not amounts.
 */
function fractionDigits(amount: number, precision: MoneyPrecision): number {
  if (precision === 'rate') return 6;
  const magnitude = Math.abs(amount);
  if (amount === 0 || magnitude >= 0.01) return 2;
  return magnitude >= 0.0001 ? 4 : 6;
}

function moneyFormatter(currency: DisplayCurrency, amount: number, precision: MoneyPrecision): Intl.NumberFormat {
  const digits = fractionDigits(amount, precision);
  const key = `${currency.code}:${digits}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en', { style: 'currency', currency: currency.code, minimumFractionDigits: 2, maximumFractionDigits: digits });
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

function convertUsd(usd: number | null | undefined, currency: DisplayCurrency): number | null {
  if (usd == null || !Number.isFinite(usd) || currency.rate === null) return null;
  if (!Number.isFinite(currency.rate) || currency.rate <= 0) return null;
  const amount = usd * currency.rate;
  // A negative zero would print as an amount owed.
  return Number.isFinite(amount) ? (amount === 0 ? 0 : amount) : null;
}

/** Splits a formatted amount around its digits, with the currency mark swapped for `currencySymbol`. */
function moneyParts(currency: DisplayCurrency, amount: number, precision: MoneyPrecision) {
  const formatter = moneyFormatter(currency, amount, precision);
  let prefix = '';
  let digits = '';
  let suffix = '';
  for (const part of formatter.formatToParts(amount)) {
    if (['integer', 'decimal', 'fraction', 'group'].includes(part.type)) { digits += part.value; continue; }
    if (part.type === 'literal' && !part.value.trim()) continue;
    const value = part.type === 'currency' ? currencySymbol(currency.code) : part.value;
    if (digits) suffix += value;
    else prefix += value;
  }
  return { formatter, prefix, digits, suffix };
}

/** Conversion is presentation-only: callers keep using the original USD values for math and APIs. */
export function formatCurrency(usd: number | null | undefined, currency = USD_CURRENCY, precision: MoneyPrecision = 'money'): string {
  const amount = convertUsd(usd, currency);
  if (amount === null) return '—';
  const { prefix, digits, suffix } = moneyParts(currency, amount, precision);
  return `${prefix}${digits}${suffix}`;
}

/** Derive both moving digits and surrounding currency marks from the same parts as static copy. */
export function currencyReadout(usd: number | null | undefined, currency = USD_CURRENCY, precision: MoneyPrecision = 'money'): RollingReadout | undefined {
  const amount = convertUsd(usd, currency);
  if (amount === null) return undefined;
  const { formatter, prefix, suffix } = moneyParts(currency, amount, precision);
  const options = formatter.resolvedOptions();
  return { number: Math.abs(amount), prefix, suffix, format: { minimumFractionDigits: options.minimumFractionDigits, maximumFractionDigits: options.maximumFractionDigits, useGrouping: options.useGrouping } };
}
