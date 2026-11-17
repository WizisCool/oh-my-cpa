import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CloseOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '../../../components/icons';
import { SearchInput } from '../../../components/common/SearchInput';
import { useT } from '../../../i18n';
import { facetValues, filterRows, INSIGHTS_FILTER_KEYS, type InsightsCube, type InsightsDimension, type InsightsFilterKey, type InsightsFilters } from '../../../types/insightsCube';
import type { InsightsClientItem } from '../../../types/insights';
import { clientDisplayName } from '../../../types/clientAgents';
import { hasFilters, toggleFilter } from '../insightsViewState';
import type { InsightsLabels } from '../../../hooks/useInsightsLabels';
import { InsightsValue } from './InsightsValue';
import { ClientValue } from './ClientAttributionPanel';
import styles from '../insights.module.css';

const COUNT = new Intl.NumberFormat('en');

interface InsightsFilterBarProps {
  cube: InsightsCube | undefined;
  filters: InsightsFilters;
  labels: InsightsLabels;
  /** The model dimension the console names models by: the call point or the served model. */
  modelDimension: 'call_point' | 'model';
  /** The client ranking, read under every filter but its own, which is what a client's count is. */
  clients?: readonly InsightsClientItem[];
  onChange: (filters: InsightsFilters) => void;
  /** Opens a value's detail from its chip. */
  onOpen?: (dimension: InsightsDimension, id: string) => void;
  /** The request list behind the narrowed view. */
  onViewRequests?: () => void;
  /** False when the request list could not carry every filter. */
  canViewRequests?: boolean;
}

/**
 * The page's narrowing: one chip per chosen value, and an "add" control that walks dimension then
 * value. A value's count is what selecting it would leave, computed against every other filter but
 * not its own dimension's, so picking a second key never shows the first key's zeros.
 *
 * While anything is chosen the bar holds to the top of the scroll, so a narrowing made from a ranking
 * far down the page stays in sight, and a new chip settles in with a short entrance.
 */
export const InsightsFilterBar: React.FC<InsightsFilterBarProps> = ({ cube, filters, labels, modelDimension, clients, onChange, onOpen, onViewRequests, canViewRequests = true }) => {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const [dimension, setDimension] = React.useState<InsightsFilterKey | null>(null);
  const [search, setSearch] = React.useState('');
  const dimensions = INSIGHTS_FILTER_KEYS.filter((item) => item !== (modelDimension === 'model' ? 'call_point' : 'model'));
  const clientCategory = (id: string) => clients?.find((item) => item.id === id)?.category;

  const facets = React.useMemo(() => {
    if (dimension === 'client') {
      // `other` folds many programs together, so it names no one client to narrow to.
      return (clients ?? []).filter((item) => item.id !== 'other' && item.requests > 0).map((item) => ({ id: item.id, requests: item.requests }));
    }
    if (!cube || !dimension) return [];
    return facetValues(cube, filterRows(cube, cube.rows, filters, dimension), dimension);
  }, [clients, cube, dimension, filters]);
  const nameOf = (key: InsightsFilterKey, id: string) => (key === 'client' ? clientDisplayName(id, t) : labels.label(key, id));
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? facets.filter((facet) => `${nameOf(dimension!, facet.id)} ${facet.id}`.toLowerCase().includes(needle))
    : facets;
  const valueOf = (key: InsightsFilterKey, id: string, className: string, hasDetail?: boolean) => (key === 'client'
    ? <ClientValue id={id} category={clientCategory(id)} className={className} />
    : <InsightsValue dimension={key} id={id} labels={labels} hasDetail={hasDetail} className={className} />);

  const chips = INSIGHTS_FILTER_KEYS.flatMap((item) => (filters[item] ?? []).map((value) => ({ dimension: item, value })));

  const close = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setDimension(null);
      setSearch('');
    }
  };

  const panel = dimension === null ? (
    <div className={styles['filter-menu']} role="menu">
      {dimensions.map((item) => (
        <button key={item} type="button" role="menuitem" className={styles['filter-menu-item']} onClick={() => setDimension(item)}>
          {t(`insights.dim.${item}`)}
          {(filters[item]?.length ?? 0) > 0 && <span className={styles['filter-menu-count']}>{filters[item]!.length}</span>}
        </button>
      ))}
    </div>
  ) : (
    <div className={styles['filter-values']}>
      <div className={styles['filter-values-head']}>
        <Button variant="ghost" size="sm" icon={<LeftOutlined />} aria-label={t('insights.filter_back')} onClick={() => { setDimension(null); setSearch(''); }} />
        <span>{t(`insights.dim.${dimension}`)}</span>
      </div>
      <SearchInput value={search} onChange={setSearch} label={t('insights.filter_search')} autoFocus />
      <div className={styles['filter-values-list']} data-testid="insights-filter-values">
        {visible.length === 0 && <div className={styles['filter-values-empty']}>{t('insights.filter_no_values')}</div>}
        {visible.map((facet) => {
          return (
            <label key={facet.id} className={styles['filter-value']}>
              <Checkbox
                checked={(filters[dimension] ?? []).includes(facet.id)}
                onCheckedChange={() => onChange(toggleFilter(filters, dimension, facet.id))}
              />
              {valueOf(dimension, facet.id, styles['filter-value-name'], true)}
              <span className={styles['filter-value-count']}>{COUNT.format(facet.requests)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={styles['filter-bar']} data-active={chips.length > 0 || undefined} data-testid="insights-filter-bar">
      {chips.map((chip) => {
        // A client has no detail drawer; neither has traffic that carried no client key.
        const detail = chip.dimension === 'client' || (chip.dimension === 'key' && labels.isNonKey(chip.value)) ? null : chip.dimension;
        return (
        <span key={`${chip.dimension}:${chip.value}`} className={styles['filter-chip']}>
          <span className={styles['filter-chip-dim']}>{t(`insights.dim.${chip.dimension}`)}</span>
          {valueOf(chip.dimension, chip.value, styles['filter-chip-value'])}
          {onOpen && detail && (
            <button
              type="button"
              className={styles['filter-chip-action']}
              aria-label={t('insights.open_detail')}
              data-tip={t('insights.open_detail')}
              onClick={() => onOpen(detail, chip.value)}
            >
              <RightOutlined />
            </button>
          )}
          <button
            type="button"
            className={styles['filter-chip-remove']}
            aria-label={t('insights.filter_remove')}
            onClick={() => onChange(toggleFilter(filters, chip.dimension, chip.value))}
          >
            <CloseOutlined />
          </button>
        </span>
        );
      })}
      <Popover open={isOpen} onOpenChange={(next) => close(next)}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="ghost" icon={<PlusOutlined />} className={styles['filter-add']} disabled={!cube}>
              {t('insights.filter_add')}
            </Button>
          }
        />
        <PopoverContent placement="bottomLeft">
          {panel}
        </PopoverContent>
      </Popover>
      {hasFilters(filters) && (
        <Button size="sm" variant="link" className={styles['filter-clear']} onClick={() => onChange({})}>
          {t('insights.filter_clear')}
        </Button>
      )}
      {hasFilters(filters) && onViewRequests && (
        <Button size="sm" variant="link" className={styles['filter-requests']} onClick={onViewRequests} disabled={!canViewRequests} data-testid="insights-filter-requests">
          {t('insights.view_requests_link')}
        </Button>
      )}
    </div>
  );
};
