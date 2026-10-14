
import { Button, Segmented, Select } from 'antd';
import { FilterOutlined } from '../icons';

import { useT } from '../../i18n';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { ModelChartView } from '../../types/tokenDisplay';
import type { EventFilterKey } from '../../types/usageEventQuery';
import { mergeFacetOptions } from '../../types/usageEventQuery';
import type { EventGrouping } from '../../types/usageEventViewPreference';
import { EVENT_GROUPING_VALUES } from '../../types/usageEventViewPreference';
import { providerFacetLabel, usageFacetLabel } from '../../types/usageEventLabels';
import type { CredentialIndex } from '../../types/usageEventIdentity';
import type {
  UsageEventQuery,
  UsageFacets,
  UsageResultFilter,
} from '../../types/usageEvents';
import { renderFacetOption, type FacetMarkRenderer } from './RequestFacetMark';
import { ResultMarker } from './ResultMarker';
import { TimeRangeControl } from './TimeRangeControl';
import { SearchInput } from '../common/SearchInput';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import './RequestToolbar.css';
import './requestMarks.css';

interface RequestToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  query: UsageEventQuery;
  onTimeWindowChange: (window: { preset?: string; from?: number; to?: number }) => void;
  onResultChange: (result: UsageResultFilter) => void;
  committedParams: Partial<Record<EventFilterKey, string[]>>;
  onFilterChange: (key: EventFilterKey, values: string[]) => void;
  facets: UsageFacets | undefined;
  facetsFailed: boolean;
  credentials: CredentialIndex;
  resolveProviderName: (providerKey: string | null | undefined) => string;
  renderFacetMark: FacetMarkRenderer;
  filterCount: number;
  onOpenFilters: () => void;
  hasActiveFilter: boolean;
  activeFilterCount: number;
  onClearFilters: () => void;
  grouping: EventGrouping;
  onGroupingChange: (grouping: EventGrouping) => void;
}

/**
 * The request list's filter bar: the search box, the window, the result verdict,
 * the two facets worth an inline control, and the way into the rest.
 *
 * It owns the facet control's option shape for one reason: a selected value must
 * survive a capped response, and that is a property of the control rather than of
 * the page that supplies the facets.
 */
export function RequestToolbar({
  search,
  onSearchChange,
  query,
  onTimeWindowChange,
  onResultChange,
  committedParams,
  onFilterChange,
  facets,
  facetsFailed,
  credentials,
  resolveProviderName,
  renderFacetMark,
  filterCount,
  onOpenFilters,
  hasActiveFilter,
  activeFilterCount,
  onClearFilters,
  grouping,
  onGroupingChange,
}: RequestToolbarProps) {
  const t = useT();
  const { modelView, setModelView } = useTokenDisplayStyle();
  const isPhone = useIsPhoneViewport();

  /**
   * Facet options carry the window's request count; `expandProps` was dropped
   * because the count in the label is what makes the option worth reading.
   * A selected value missing from a capped response is re-added, so the control
   * can never render blank while its filter is still applied.
   */
  const facetMulti = (
    key: EventFilterKey,
    labelKey: string,
    values: UsageFacets[keyof UsageFacets] | undefined,
  ) => {
    const selected = committedParams[key] ?? [];
    return (
      <Select
        className="req-facet-select"
        mode="multiple"
        aria-label={t(labelKey)}
        placeholder={t(labelKey)}
        value={selected}
        allowClear
        maxTagCount="responsive"
        showSearch={{ optionFilterProp: 'label' }}
        optionRender={(option) => renderFacetOption(renderFacetMark, key, option)}
        onChange={(next) => onFilterChange(key, next as string[])}
        options={mergeFacetOptions(
          values,
          selected,
          // The provider dimension is stored as CPA's key, so it is labelled with
          // the operator's own name for that line; the value stays the key.
          key === 'provider'
            ? (entry) => providerFacetLabel(resolveProviderName(entry.value), entry.requests)
            : usageFacetLabel,
          (value) =>
            key === 'provider'
              ? resolveProviderName(value)
              : key === 'auth_index'
                ? `${credentials.get(value)?.name || value} · ${value}`
                : value,
        )}
        notFoundContent={facetsFailed ? t('events.facets_error') : undefined}
      />
    );
  };

  const searchInput = (
    <SearchInput
      className="request-search"
      label={t('events.search_hint')}
      placeholder={t('events.search_placeholder')}
      value={search}
      onChange={onSearchChange}
    />
  );
  const timeWindow = (
    <TimeRangeControl
      preset={query.preset}
      from={query.from}
      to={query.to}
      onChange={onTimeWindowChange}
    />
  );
  const resultFilter = (
    <Segmented
      className="req-result-segmented"
      aria-label={t('events.col_result')}
      value={query.result}
      onChange={(value) => {
        onResultChange(value as UsageResultFilter);
      }}
      options={(['all', 'success', 'failed'] as const).map((value) => ({
        value,
        // The marker reuses the Result column's own vocabulary, so
        // "success" and "failed" mean the same thing in the filter and
        // in the list it filters. 'all' gets none: it is the absence of
        // a verdict, and two bullets would read as a third outcome.
        label: (
          <span className="req-result-option">
            {value !== 'all' && <ResultMarker kind={value} />}
            {t(`events.filter_${value}`)}
          </span>
        ),
      }))}
    />
  );
  const moreFilters = (
    <Button
      className="req-more-filters"
      aria-label={t('events.more_filters')}
      icon={<FilterOutlined />}
      onClick={onOpenFilters}
    >
      {/* Beside the search box on a phone the glyph and the count are the control; its name
          stays in the accessible label. */}
      {isPhone ? null : t('events.more_filters')}
      {filterCount > 0 ? <span className="req-more-filters-count">{filterCount}</span> : null}
    </Button>
  );
  const facetsNote = facetsFailed && (
    <span className="req-facets-note" role="status">
      {t('events.facets_error')}
    </span>
  );
  const resetFilters = hasActiveFilter && (
    <Button type="text" className="req-reset-filters" onClick={onClearFilters}>
      {t('events.reset')}
      <span className="req-reset-count">{activeFilterCount || 1}</span>
    </Button>
  );
  const groupingSelect = (
    <Select
      aria-label={t('events.group_by')}
      value={grouping}
      onChange={(value) => onGroupingChange(value as EventGrouping)}
      options={EVENT_GROUPING_VALUES.map((value) => ({
        value,
        label: t(`events.group_${value}`),
      }))}
    />
  );
  const modelViewToggle = (
    <Segmented
      className="req-model-view-toggle"
      value={modelView}
      onChange={(value) => setModelView(value as ModelChartView)}
      options={[
        { value: 'call', label: t('dash.models.view_call') },
        { value: 'model', label: t('dash.models.view_model') },
      ]}
      aria-label={t('events.model_view_toggle')}
    />
  );

  // A phone gets the same controls in two rows instead of five: what is typed or opened stays
  // put, and every choice that is a single tap swipes in one strip (docs/design.md §8).
  if (isPhone) {
    return (
      <section className="request-toolbar is-phone" aria-label={t('events.filters')}>
        <div className="request-filters">
          {searchInput}
          {moreFilters}
        </div>
        <div className="request-filter-strip">
          {timeWindow}
          {resultFilter}
          {facetMulti('model', 'events.col_model', facets?.models)}
          {facetMulti('provider', 'events.provider', facets?.providers)}
          {groupingSelect}
          {modelViewToggle}
          {resetFilters}
        </div>
        {facetsNote}
      </section>
    );
  }

  return (
    <section className="request-toolbar" aria-label={t('events.filters')}>
      <div className="request-filters">
        {searchInput}
        {timeWindow}
        {resultFilter}
        {facetMulti('model', 'events.col_model', facets?.models)}
        {facetMulti('provider', 'events.provider', facets?.providers)}
        {moreFilters}
      </div>
      <div className="request-toolbar-bottom">
        {facetsNote}
        <div className="request-actions">
          {resetFilters}
          {groupingSelect}
          {modelViewToggle}
        </div>
      </div>
    </section>
  );
}
