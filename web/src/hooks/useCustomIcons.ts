import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { CUSTOM_ICONS_QUERY_KEY } from '../types/customIcons';

export function useCustomIcons(isEnabled = true) {
  return useQuery({
    queryKey: CUSTOM_ICONS_QUERY_KEY,
    queryFn: api.getCustomIcons,
    enabled: isEnabled,
    staleTime: 30000,
  });
}
