import React from 'react';
import { Button, Drawer, Input, InputNumber, Segmented, Select, Tooltip } from 'antd';
import type { UsageCostFilter, UsageFacetValue, UsageFacets, UsageResultFilter } from '../../types/usageEvents';
import { providerFacetLabel, usageFacetLabel } from '../../types/usageEventLabels';
import { ResultMarker } from './ResultMarker';
import type { EventFilterKey } from '../../types/usageEventQuery';
import { parseUsageRangeBound } from '../../types/usageEvents';
import type { RangeFieldKey, RangeBound } from '../../types/usageEventFilters';
import type { UsageEventsFilterDraft, UsageEventsView } from '../../types/usageEventFilters';
import {
  EMPTY_FILTER_DRAFT,
  draftFromView,
  draftToView,
  isDraftDirty,
  validateFilterDraft,
} from '../../types/usageEventFilters';
import { useT } from '../../i18n';
import './RequestFilterDrawer.css';

/**
 * canonicalViewKey gives the committed view a stable identity so the drawer can
 * tell "the operator reopened the same view" from "the view changed underneath".
 *
 * It is built by JSON-encoding sorted entries rather than by joining on `,` and
 * `&`: those characters are legal inside a model name, a source label and a caller
 * mask, so a delimiter-based key would report two different views as identical and
 * leave a stale draft in place.
 */
function canonicalViewKey(view: UsageEventsView): string {
  const entries = Object.keys(view.params)
    .sort()
    .map((key) => [key, [...(view.params[key as EventFilterKey] ?? [])]]);
  return JSON.stringify([view.result, entries]);
}

/** One facet's wiring: wire key, facet field, and the i18n label. */
interface FacetSpec {
  key: EventFilterKey;
  facet: keyof UsageFacets;
  labelKey: string;
}

/**
 * Facets are grouped the way an operator reasons about a request rather than the
 * way the database is shaped: what was asked, how it was routed, and what it
 * cost. One flat list of eleven dropdowns is technically complete and
 * practically unusable, because finding a field means reading all of them.
 */
const REQUEST_FACETS: FacetSpec[] = [
  { key: 'auth_type', facet: 'auth_types', labelKey: 'events.auth_type' },
  { key: 'reasoning', facet: 'reasoning_efforts', labelKey: 'events.reasoning_effort' },
  { key: 'service_tier', facet: 'service_tiers', labelKey: 'events.service_tier' },
];

const ROUTING_FACETS: FacetSpec[] = [
  { key: 'auth_index', facet: 'auth_indexes', labelKey: 'events.credential_filter' },
  { key: 'source', facet: 'sources', labelKey: 'events.source' },
  { key: 'api_key', facet: 'api_group_keys', labelKey: 'events.caller' },
  { key: 'executor', facet: 'executors', labelKey: 'events.executor' },
];

/**
 * The alias is an exact-match dimension, not a substring search: CPA reports the
 * alias the client asked for, and the filter compares it for equality. Rendering
 * it as a text box would leave every edit silently ignored, so it gets the same
 * multi-select as the other exact dimensions.
 */
const ALIAS_FACETS: FacetSpec[] = [
  { key: 'model_alias', facet: 'model_aliases', labelKey: 'events.model_alias' },
];

const TEXT_FIELDS: Array<{ key: EventFilterKey; labelKey: string }> = [
  { key: 'ua', labelKey: 'events.col_ua' },
  { key: 'endpoint', labelKey: 'events.endpoint' },
  { key: 'request_id', labelKey: 'events.col_request_id' },
];

export interface RequestFilterDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The committed view. Opening the drawer copies it into a draft. */
  committed: UsageEventsView;
  facets?: UsageFacets;
  facetsFailed: boolean;
  credentialName: (authIndex: string) => string;
  /** Labels the provider dimension with the operator's name for that line; the
   *  stored value stays CPA's key, which is what the filter is applied on. */
  providerName: (providerKey: string) => string;
  /** Called once with the validated draft when the operator applies it. */
  onApply: (view: UsageEventsView) => void;
}

/**
 * The advanced filter drawer.
 *
 * Edits are a draft rather than live state. A range field is unusable if every
 * keystroke re-queries: typing "30000" would briefly filter at 300, 3000 and
 * 30000 ms, and the operator would watch the list empty and refill. Apply commits
 * the panel in one navigation; Cancel and Escape discard it.
 */
export const RequestFilterDrawer: React.FC<RequestFilterDrawerProps> = ({
  open,
  onClose,
  committed,
  facets,
  facetsFailed,
  credentialName,
  providerName,
  onApply,
}) => {
  const t = useT();
  const [draft, setDraft] = React.useState<UsageEventsFilterDraft>(EMPTY_FILTER_DRAFT);

  /**
   * Identity of the committed view. A draft is only ever valid against the view it
   * was seeded from, so a change made elsewhere while the panel is open (a chip
   * removed, a drill-down navigated, the Back button) invalidates it rather than
   * letting Apply restore filters the operator already cleared.
   */
  const committedKey = React.useMemo(() => canonicalViewKey(committed), [committed]);
  const seededKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      seededKeyRef.current = null;
      return;
    }
    if (seededKeyRef.current === committedKey) return;
    seededKeyRef.current = committedKey;
    setDraft(draftFromView(committed));
  }, [open, committedKey, committed]);

  const errors = React.useMemo(() => validateFilterDraft(draft), [draft]);
  const isDirty = isDraftDirty(draft, committed);

  const setMulti = (key: EventFilterKey, values: string[]) =>
    setDraft((prev) => ({ ...prev, multi: { ...prev.multi, [key]: values } }));
  const setText = (key: EventFilterKey, value: string) =>
    setDraft((prev) => ({ ...prev, text: { ...prev.text, [key]: value } }));
  const setRange = (key: RangeFieldKey, side: 'min' | 'max', value: RangeBound | undefined) =>
    setDraft((prev) => ({
      ...prev,
      ranges: { ...prev.ranges, [key]: { ...prev.ranges[key], [side]: value } },
    }));

  const handleApply = () => {
    if (Object.keys(errors).length > 0) return;
    onApply(draftToView(draft));
  };

  /**
   * Facet options carry the window's request count. A selected value missing from
   * a capped response is re-added, so the control can never render blank for a
   * filter that is still applied.
   */
  const facetOptions = (spec: FacetSpec): Array<{ value: string; label: string }> => {
    const values: UsageFacetValue[] = facets?.[spec.facet] ?? [];
    const options = values.map((entry) => ({
      value: entry.value,
      label:
        spec.key === 'auth_index'
          ? `${credentialName(entry.value)} · ${usageFacetLabel(entry)}`
          : spec.key === 'provider'
            ? providerFacetLabel(providerName(entry.value), entry.requests)
            : usageFacetLabel(entry),
    }));
    const known = new Set(options.map((option) => option.value));
    for (const value of draft.multi[spec.key] ?? []) {
      if (known.has(value)) continue;
      known.add(value);
      options.push({
        value,
        label:
          spec.key === 'auth_index'
            ? `${credentialName(value)} · ${value}`
            : spec.key === 'provider'
              ? providerName(value)
              : value,
      });
    }
    return options;
  };

  const section = (titleKey: string, children: React.ReactNode) => (
    <section className="req-filter-group">
      <h3 className="req-filter-group-title">{t(titleKey)}</h3>
      <div className="req-filter-group-body">{children}</div>
    </section>
  );

  /**
   * `errorKeys` is a list rather than one key because a range can fail in two
   * independent ways: a single bound can be unusable, and the pair can be
   * reversed. Showing only the first kind silently swallowed the reversed-range
   * message, which was the one that explained why Apply was disabled.
   */
  const row = (labelKey: string, labelFor: string, control: React.ReactNode, errorKeys?: string[]) => (
    <div className="req-filter-row">
      <label className="req-filter-label" htmlFor={labelFor}>
        {t(labelKey)}
      </label>
      <div className="req-filter-control">
        {control}
        {errorKeys?.map((key) =>
          errors[key] ? (
            <p className="req-filter-error" key={key}>
              {t(errors[key]!)}
            </p>
          ) : null,
        )}
      </div>
    </div>
  );

  const multiRow = (spec: FacetSpec) =>
    row(
      spec.labelKey,
      `req-multi-${spec.key}`,
      <Select
        id={`req-multi-${spec.key}`}
        // Aliases accept values the window does not report, because an operator
        // filtering by alias is often looking for one that has stopped appearing -
        // a rename or a retired alias is exactly when they go looking. The other
        // dimensions are facets of what exists, so they stay selection-only.
        mode={spec.key === 'model_alias' ? 'tags' : 'multiple'}
        className="req-filter-select"
        aria-label={t(spec.labelKey)}
        placeholder={t(spec.labelKey)}
        value={draft.multi[spec.key] ?? []}
        onChange={(values) => setMulti(spec.key, values as string[])}
        options={facetOptions(spec)}
        maxTagCount="responsive"
        allowClear
        // A comma is a legal character in an alias, so it must not be a token
        // separator: typing one would silently split the value in two.
        tokenSeparators={[]}
        showSearch={{ optionFilterProp: 'label' }}
        notFoundContent={facetsFailed ? t('events.facets_error') : undefined}
      />,
    );

  const textRow = (field: { key: EventFilterKey; labelKey: string }) =>
    row(
      field.labelKey,
      `req-text-${field.key}`,
      <Input
        id={`req-text-${field.key}`}
        aria-label={t(field.labelKey)}
        value={draft.text[field.key] ?? ''}
        allowClear
        onChange={(event) => setText(field.key, event.target.value)}
        onPressEnter={handleApply}
      />,
    );

  const rangeRow = (key: 'latency' | 'tokens' | 'cost', labelKey: string, unit: string) => {
    // Cost is a nano-dollar decimal, which no number input can represent without
    // rounding, so that one field is a text input constrained by its own
    // validator. Latency and tokens are integral by definition.
    const isDecimal = key === 'cost';
    const bound = (side: 'min' | 'max') => {
      const value = draft.ranges[key]?.[side];
      return value === undefined ? '' : String(value);
    };
    const setBound = (side: 'min' | 'max', raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return setRange(key, side, undefined);
      // Parsed immediately so the stored draft is always the normalised value the
      // wire will receive, and an out-of-grammar entry keeps the raw text visible
      // with an error next to it rather than being silently discarded.
      const parsed = parseUsageRangeBound(key, trimmed);
      setRange(key, side, parsed === undefined ? trimmed : parsed);
    };
    const errorKeys = [`${key}_min`, `${key}_max`, key].filter((candidate) => errors[candidate]);
    return row(
      labelKey,
      `req-range-${key}-min`,
      <div className="req-range-pair">
        {isDecimal ? (
          <Input
            id={`req-range-${key}-min`}
            className="req-range-input"
            aria-label={`${t(labelKey)} · ${t('events.range_min')}`}
            placeholder={t('events.range_min')}
            value={bound('min')}
            status={errors[`${key}_min`] ? 'error' : undefined}
            onChange={(event) => setBound('min', event.target.value)}
          />
        ) : (
          <InputNumber
            id={`req-range-${key}-min`}
            className="req-range-input"
            aria-label={`${t(labelKey)} · ${t('events.range_min')}`}
            placeholder={t('events.range_min')}
            min={0}
            precision={0}
            value={bound('min') === '' ? null : Number(bound('min'))}
            onChange={(value) => setRange(key, 'min', typeof value === 'number' ? value : undefined)}
            status={errors[`${key}_min`] ? 'error' : undefined}
          />
        )}
        <span className="req-range-sep" aria-hidden="true">
          —
        </span>
        {isDecimal ? (
          <Input
            id={`req-range-${key}-max`}
            className="req-range-input"
            aria-label={`${t(labelKey)} · ${t('events.range_max')}`}
            placeholder={t('events.range_max')}
            value={bound('max')}
            status={errors[`${key}_max`] ? 'error' : undefined}
            onChange={(event) => setBound('max', event.target.value)}
          />
        ) : (
          <InputNumber
            id={`req-range-${key}-max`}
            className="req-range-input"
            aria-label={`${t(labelKey)} · ${t('events.range_max')}`}
            placeholder={t('events.range_max')}
            min={0}
            precision={0}
            value={bound('max') === '' ? null : Number(bound('max'))}
            onChange={(value) => setRange(key, 'max', typeof value === 'number' ? value : undefined)}
            status={errors[`${key}_max`] ? 'error' : undefined}
          />
        )}
        <span className="req-range-unit">{unit}</span>
      </div>,
      errorKeys,
    );
  };

  return (
    <Drawer
      className="req-filter-drawer"
      title={t('events.advanced_filters')}
      open={open}
      onClose={onClose}
      // A fixed width beats antd's responsive preset here: the panel is a form
      // with a fixed label column, and the two-step resize it would otherwise do
      // mid-transition is visible as a jitter.
      size={420}
      footer={
        <div className="req-filter-drawer-footer">
          <Button onClick={() => setDraft(EMPTY_FILTER_DRAFT)}>{t('events.reset')}</Button>
          <div className="req-filter-drawer-footer-actions">
            <Button data-testid="req-filter-cancel" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="req-filter-apply"
              type="primary"
              disabled={!isDirty || Object.keys(errors).length > 0}
              onClick={handleApply}
            >
              {t('events.apply_filters')}
            </Button>
          </div>
        </div>
      }
    >
      {facetsFailed && (
        <p className="req-filter-note" role="status">
          {t('events.facets_error')}
        </p>
      )}

      {section(
        'events.group_request',
        <>
          {row(
            'events.col_result',
            'req-result-segmented',
            <Segmented
              id="req-result-segmented"
              aria-label={t('events.col_result')}
              value={draft.result}
              onChange={(value) => setDraft((prev) => ({ ...prev, result: value as UsageResultFilter }))}
              options={[
                {
                  value: 'all',
                  label: (
                    <span className="req-result-option">{t('events.filter_all')}</span>
                  ),
                },
                {
                  value: 'success',
                  label: (
                    <span className="req-result-option">
                      <ResultMarker kind="success" />
                      {t('events.filter_success')}
                    </span>
                  ),
                },
                {
                  value: 'failed',
                  label: (
                    <span className="req-result-option">
                      <ResultMarker kind="failed" />
                      {t('events.filter_failed')}
                    </span>
                  ),
                },
              ]}
            />,
          )}
          {REQUEST_FACETS.map(multiRow)}
          {ALIAS_FACETS.map(multiRow)}
        </>
      )}

      {section(
        'events.group_routing',
        <>
          {ROUTING_FACETS.map(multiRow)}
          {TEXT_FIELDS.map(textRow)}
        </>
      )}

      {section(
        'events.group_performance',
        <>
          {rangeRow('latency', 'events.col_latency', t('events.unit_ms'))}
          {rangeRow('tokens', 'events.col_tokens', t('events.unit_tokens'))}
        </>
      )}

      {section(
        'events.group_cost',
        <>
          {row(
            'events.cost_state',
            'req-cost-segmented',
            <Segmented
              id="req-cost-segmented"
              aria-label={t('events.cost_state')}
              value={draft.cost}
              onChange={(value) => setDraft((prev) => ({ ...prev, cost: value as UsageCostFilter }))}
              options={[
                { value: 'all', label: t('events.cost_any') },
                // "Unpriced" is permanent: no later price backfills the record, so
                // the option says so rather than letting it read as a transient
                // state the operator can wait out.
                {
                  value: 'priced',
                  label: (
                    <Tooltip title={t('events.cost_priced_hint')}>
                      <span>{t('events.cost_priced')}</span>
                    </Tooltip>
                  ),
                },
                {
                  value: 'unpriced',
                  label: (
                    <Tooltip title={t('events.cost_unpriced_hint')}>
                      <span>{t('events.cost_unpriced_short')}</span>
                    </Tooltip>
                  ),
                },
              ]}
            />,
          )}
          {rangeRow('cost', 'events.col_cost', t('events.unit_usd'))}
        </>
      )}
    </Drawer>
  );
};
