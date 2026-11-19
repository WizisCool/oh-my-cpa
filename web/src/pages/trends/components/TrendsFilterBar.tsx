import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import { api, apiErrorCode } from '../../../api/client';
import { CloseOutlined, LeftOutlined, PlusOutlined } from '../../../components/icons';
import { SearchInput } from '../../../components/common/SearchInput';
import { useT } from '../../../i18n';
import { insightsPollInterval, type InsightsBucketChoice, type InsightsRange } from '../../../types/insights';
import type { TrendsTelemetryResponse, TrendsUsageGroupOption, TrendsUsageResponse } from '../../../types/trends';
import {
  TRENDS_FILTER_KEYS,
  filterGroupByForKey,
  hasTrendsFilters,
  omitTrendsFilter,
  trendsFilterDimensions,
  trendsFilterOptions,
  trendsWindowParams,
  type TrendsFilterKey,
  type TrendsFilters,
} from '../trendsLogic';
import { TrendsValue, type TrendsIdentity } from '../useTrendsIdentity';
import styles from '../trends.module.css';

const COUNT = new Intl.NumberFormat('en');

export interface TrendsFilterBarProps {
  filters: TrendsFilters;
  range: InsightsRange;
  bucket: InsightsBucketChoice;
  modelView: 'model' | 'call';
  usage?: TrendsUsageResponse;
  telemetry?: TrendsTelemetryResponse;
  isRangeReady: boolean;
  isDemo: boolean;
  isPollingActive: boolean;
  fallbackName: (key: TrendsFilterKey, id: string) => string | undefined;
  onPrimeName: (key: TrendsFilterKey, option: TrendsUsageGroupOption) => void;
  identity: TrendsIdentity;
  eventsHref: string | null;
  onToggle: (key: TrendsFilterKey, value: string) => void;
  onClear: () => void;
  onNavigate: (to: string) => void;
}

/**
 * The Trends page's explicit filter bar: active filter chips (sticky while scrolling),
 * an Insights-style dimension/value picker with live request counts, clear-all, and a link
 * to the matching request records.
 */
export const TrendsFilterBar: React.FC<TrendsFilterBarProps> = ({
  filters,
  range,
  bucket,
  modelView,
  usage,
  telemetry,
  isRangeReady,
  isDemo,
  isPollingActive,
  fallbackName,
  onPrimeName,
  identity,
  eventsHref,
  onToggle,
  onClear,
  onNavigate,
}) => {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const [dimension, setDimension] = React.useState<TrendsFilterKey | null>(null);
  const [search, setSearch] = React.useState('');

  const dimensions = React.useMemo(() => trendsFilterDimensions(modelView), [modelView]);
  const targetGroupBy = dimension ? filterGroupByForKey(dimension) : '';
  const optionFilters = React.useMemo(
    () => (!dimension || isDemo ? {} : omitTrendsFilter(filters, dimension)),
    [dimension, filters, isDemo],
  );
  const queryString = dimension ? trendsWindowParams(range, bucket, targetGroupBy, optionFilters) : '';

  const optionsQuery = useQuery({
    queryKey: ['trends-usage', queryString],
    queryFn: () => api.getTrendsUsage(queryString),
    enabled: isOpen && dimension !== null && isRangeReady,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });

  const matchingUsage = React.useMemo(() => {
    if (!dimension) return undefined;
    if (optionsQuery.data && !optionsQuery.isPlaceholderData && optionsQuery.data.group_by === targetGroupBy) {
      return optionsQuery.data;
    }
    if (
      usage
      && usage.group_by === targetGroupBy
      && trendsWindowParams(range, bucket, usage.group_by, filters) === queryString
    ) {
      return usage;
    }
    return undefined;
  }, [bucket, dimension, filters, optionsQuery.data, optionsQuery.isPlaceholderData, queryString, range, targetGroupBy, usage]);

  const matchingTelemetry = React.useMemo(() => {
    if (!dimension || !matchingUsage || !telemetry) return undefined;
    if (telemetry.group_by !== matchingUsage.group_by) return undefined;
    if (trendsWindowParams(range, bucket, telemetry.group_by, filters) !== queryString) return undefined;
    if (telemetry.window.from !== matchingUsage.window.from || telemetry.window.to !== matchingUsage.window.to) return undefined;
    return telemetry;
  }, [bucket, dimension, filters, matchingUsage, queryString, range, telemetry]);

  const options = React.useMemo(
    () => (dimension ? trendsFilterOptions(matchingUsage, matchingTelemetry) : []),
    [dimension, matchingTelemetry, matchingUsage],
  );

  const needle = search.trim().toLowerCase();
  const visible = React.useMemo(() => {
    if (!dimension || !needle) return options;
    return options.filter((option) => `${identity.label(dimension, option)} ${option.id} ${option.mask ?? ''}`.toLowerCase().includes(needle));
  }, [dimension, identity, needle, options]);

  const chips = TRENDS_FILTER_KEYS.flatMap((key) => (filters[key] ?? []).map((value) => ({ key, value })));

  const close = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setDimension(null);
      setSearch('');
    }
  };

  const panel = dimension === null ? (
    <div className={styles['filter-menu']}>
      {dimensions.map((item) => (
        <button key={item} type="button" className={styles['filter-menu-item']} onClick={() => setDimension(item)}>
          {t(`trends.filter.${item}`)}
          {(filters[item]?.length ?? 0) > 0 && <span className={styles['filter-menu-count']}>{filters[item]!.length}</span>}
        </button>
      ))}
    </div>
  ) : (
    <div className={styles['filter-values']}>
      <div className={styles['filter-values-head']}>
        <Button variant="ghost" size="sm" icon={<LeftOutlined />} aria-label={t('trends.filter_back')} onClick={() => { setDimension(null); setSearch(''); }} />
        <span>{t(`trends.filter.${dimension}`)}</span>
      </div>
      <SearchInput value={search} onChange={setSearch} label={t('trends.filter_search')} autoFocus />
        <div className={styles['filter-values-list']} data-testid="trends-filter-values">
        {optionsQuery.isFetching && !matchingUsage ? (
          <div className={styles['filter-values-loading']}><Spinner size="small" /></div>
        ) : optionsQuery.isError && !matchingUsage ? (
          <div className={styles['filter-values-empty']}>{t('trends.filter_load_failed')}</div>
        ) : visible.length === 0 ? (
          <div className={styles['filter-values-empty']}>{t('trends.filter_no_values')}</div>
        ) : (
          visible.map((option) => (
            <label key={option.id} className={styles['filter-value']}>
              <Checkbox
                checked={(filters[dimension] ?? []).includes(option.id)}
                onCheckedChange={() => {
                  onPrimeName(dimension, option);
                  onToggle(dimension, option.id);
                }}
              />
              <TrendsValue
                className={styles['filter-value-name']}
                mark={identity.mark(dimension, option.id)}
                name={identity.label(dimension, option)}
                isTipOnOverflow={false}
              />
              {option.requests > 0 && <span className={styles['filter-value-count']}>{COUNT.format(option.requests)}</span>}
            </label>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className={styles['filter-bar']} data-active={chips.length > 0 || undefined} data-testid="trends-filters">
      {chips.map(({ key, value }) => (
        <span key={`${key}\u0000${value}`} className={styles['filter-chip']}>
          <span className={styles['filter-chip-dim']}>{t(`trends.filter.${key}`)}</span>
          <TrendsValue
            className={styles['filter-chip-value']}
            mark={identity.mark(key, value)}
            name={identity.label(key, { id: value, label: fallbackName(key, value) })}
          />
          <button
            type="button"
            className={styles['filter-chip-remove']}
            aria-label={t('common.action_on', { action: t('trends.filter_remove'), target: value })}
            onClick={() => onToggle(key, value)}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      <Popover open={isOpen} onOpenChange={(next) => close(next)}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="ghost" icon={<PlusOutlined />} className={styles['filter-add']} disabled={!isRangeReady} data-testid="trends-filter-add">
              {t('trends.filter_add')}
            </Button>
          }
        />
        <PopoverContent placement="bottomLeft">
          {panel}
        </PopoverContent>
      </Popover>
      {hasTrendsFilters(filters) && (
        <Button size="sm" variant="link" className={styles['filter-clear']} onClick={onClear}>
          {t('trends.filter_clear')}
        </Button>
      )}
      {hasTrendsFilters(filters) && (
        <Button size="sm" variant="link" className={styles['filter-requests']} onClick={() => eventsHref && onNavigate(eventsHref)} disabled={!eventsHref} data-testid="trends-filter-requests">
          {t('trends.view_requests_link')}
        </Button>
      )}
    </div>
  );
};
