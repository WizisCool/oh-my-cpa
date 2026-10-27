import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EXCHANGE_RATES_QUERY_KEY } from '../types/currencyDisplay';

export function useExchangeRates(isEnabled = true) {
  return useQuery({
    queryKey: EXCHANGE_RATES_QUERY_KEY,
    queryFn: api.getExchangeRates,
    enabled: isEnabled,
    staleTime: 60 * 60 * 1000,
    refetchInterval: isEnabled ? 60 * 60 * 1000 : false,
    meta: { silent: true },
  });
}
