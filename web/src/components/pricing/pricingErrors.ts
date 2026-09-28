import { ApiError, describeError } from '../../api/client';
import type { TFunc } from '../../i18n';

/**
 * The pricing API's refusal codes, in words. A refusal the console knows - a model outside the
 * catalogue, an OpenRouter id that is not listed, an automatic switch that would match nothing -
 * is stated in the reader's language; anything else falls back to the shared error text.
 */
export function pricingErrorText(t: TFunc, error: unknown): string {
  if (error instanceof ApiError && error.data && typeof error.data === 'object') {
    const code = (error.data as { code?: unknown }).code;
    if (typeof code === 'string' && PRICING_ERROR_CODES.has(code)) return t(`pricing.error.${code}`);
  }
  return describeError(error);
}

const PRICING_ERROR_CODES = new Set([
  'pricing_model_not_in_catalog',
  'pricing_upstream_not_found',
  'pricing_no_automatic_match',
  'pricing_invalid_mode',
]);
