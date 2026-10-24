import React from 'react';
import { Button, Checkbox, Popover } from 'antd';
import { CloseOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '../../../components/icons';
import { SearchInput } from '../../../components/common/SearchInput';
import { useT } from '../../../i18n';
import { facetValues, filterRows, INSIGHTS_DIMENSIONS, type InsightsCube, type InsightsDimension, type InsightsFilters } from '../insightsCube';
import { hasFilters, toggleFilter } from '../insightsViewState';
import type { InsightsLabels } from '../useInsightsLabels';
import { InsightsValue } from './InsightsValue';
import styles from '../insights.module.css';

const COUNT = new Intl.NumberFormat('en');

interface InsightsFilterBarProps {
  cube: InsightsCube | undefined;
  filters: InsightsFilters;
  labels: InsightsLabels;
  /** The model dimension the console names models by: the call point or the served model. */
  modelDimension: 'call_point' | 'model';
  onChange: (filters: InsightsFilters) => void;
  /** Opens a key's detail from its chip. */
  onOpenKey?: (id: string) => void;
}

/**
 * The page's narrowing: one chip per chosen value, and an "add" control that walks dimension then
 * value. A value's count is what selecting it would leave, computed against every other filter but
 * not its own dimension's, so picking a second key never shows the first key's zeros.
 *
 * While anything is chosen the bar holds to the top of the scroll, so a narrowing made from a ranking
 * far down the page stays in sight, and a new chip settles in with a short entrance.
 */
export const InsightsFilterBar: React.FC<InsightsFilterBarProps> = ({ cube, filters, labels, modelDimension, onChange, onOpenKey }) => {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const [dimension, setDimension] = React.useState<InsightsDimension | null>(null);
  const [search, setSearch] = React.useState('');
  const dimensions = INSIGHTS_DIMENSIONS.filter((item) => item !== (modelDimension === 'model' ? 'call_point' : 'model'));

  const facets = React.useMemo(() => {
    if (!cube || !dimension) return [];
    return facetValues(cube, filterRows(cube, cube.rows, filters, dimension), dimension);
  }, [cube, dimension, filters]);
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? facets.filter((facet) => `${labels.label(dimension!, facet.id)} ${facet.id}`.toLowerCase().includes(needle))
    : facets;

  const chips = INSIGHTS_DIMENSIONS.flatMap((item) => (filters[item] ?? []).map((value) => ({ dimension: item, value })));

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
        <Button type="text" size="small" icon={<LeftOutlined />} aria-label={t('insights.filter_back')} onClick={() => { setDimension(null); setSearch(''); }} />
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
                onChange={() => onChange(toggleFilter(filters, dimension, facet.id))}
              />
              <InsightsValue dimension={dimension} id={facet.id} labels={labels} hasDetail className={styles['filter-value-name']} />
              <span className={styles['filter-value-count']}>{COUNT.format(facet.requests)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={styles['filter-bar']} data-active={chips.length > 0 || undefined} data-testid="insights-filter-bar">
      {chips.map((chip) => (
        <span key={`${chip.dimension}:${chip.value}`} className={styles['filter-chip']}>
          <span className={styles['filter-chip-dim']}>{t(`insights.dim.${chip.dimension}`)}</span>
          <InsightsValue dimension={chip.dimension} id={chip.value} labels={labels} className={styles['filter-chip-value']} />
          {chip.dimension === 'key' && onOpenKey && !labels.isNonKey(chip.value) && (
            <button
              type="button"
              className={styles['filter-chip-action']}
              aria-label={t('insights.open_detail')}
              title={t('insights.open_detail')}
              onClick={() => onOpenKey(chip.value)}
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
      ))}
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={isOpen}
        onOpenChange={close}
        content={panel}
        arrow={false}
        destroyOnHidden
      >
        <Button size="small" type="text" icon={<PlusOutlined />} className={styles['filter-add']} disabled={!cube}>
          {t('insights.filter_add')}
        </Button>
      </Popover>
      {hasFilters(filters) && (
        <Button size="small" type="link" className={styles['filter-clear']} onClick={() => onChange({})}>
          {t('insights.filter_clear')}
        </Button>
      )}
    </div>
  );
};
