import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DownOutlined, RightOutlined, UpOutlined } from '../icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { ProviderBrandIcon } from '../LobeIcon';
import { pluginOAuthProviderKeys, pluginOAuthProviderLogos, pluginOAuthProviderTitles } from '../../types/pluginOAuthProviders';
import { usePreference } from '../../hooks/usePreference';
import { parseProviderIcons, PROVIDER_ICONS_PREFERENCE } from '../../types/providerIcons';
import type { ManagementOverview, ManagementOverviewProvider } from '../../types/management';
import { isSlidingRange, type DashboardRange } from '../../types/dashboard';
import {
  activityBlocks,
  aggregateProviders,
  type AggregatedProvider,
} from './dashboardProvidersLogic';
import { successRateTone, type VerdictTone } from '../../types/usageEventMetrics';
import { EmptyState } from '../common/EmptyState';
import { SectionHeading } from '../common/SectionHeading';
import { Tag } from '../common/Tag';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { ProviderActivityStrip } from './ProviderActivityStrip';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import { useRankedSortableList } from '../../hooks/useSortableList';
import { DASHBOARD_PROVIDER_ORDER_PREFERENCE } from '../../types/dashboardLayout';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import { formatMinuteSpan } from '../../utils/dateTimeFormat';
import './dashboard.css';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

/**
 * Rows the panel shows before it folds the rest behind a toggle. The list is sorted with the
 * channels that serve, by volume, first, so the fold hides the quiet tail rather than a sample;
 * without it an operator with dozens of providers scrolled past the whole list to reach the
 * panels below it.
 */
const PROVIDER_PREVIEW_LIMIT = 8;

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

/**
 * The token each verdict paints with.
 *
 * A token rather than a resolved colour because the three bands *are* three theme tokens: the
 * browser resolves them against the active palette, so a custom palette moves these marks with
 * the rest of the console and no component has to know the palette at all.
 */
const RATE_TONE_COLOR: Record<VerdictTone, string> = {
  success: 'var(--success)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  neutral: 'var(--meta)',
};

export interface DashboardProvidersProps {
  overview: ManagementOverview;
  query?: string;
  range?: DashboardRange;
  enabled?: boolean;
}

export const DashboardProviders = React.memo(function DashboardProviders({
  overview,
  query,
  range,
  enabled,
}: DashboardProvidersProps) {
  const t = useT();
  const timeZone = useTimeZone();
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = useState(false);
  const isPhone = useIsPhoneViewport();
  const sliding = range ? isSlidingRange(range) : true;

  // Custom provider icon overrides
  const { value: customIcons } = usePreference<Record<string, string>>(
    PROVIDER_ICONS_PREFERENCE,
    {},
    parseProviderIcons,
  );

  // All configured AI providers from settings
  const { data: providersData } = useQuery({
    queryKey: ['management-providers', false],
    queryFn: () => api.getManagementProviders(false),
    refetchInterval: 30000,
    staleTime: 10000,
  });

  // Windowed provider traffic controlled by the top time selector
  const { data: windowProvidersData } = useQuery({
    queryKey: ['dashboard-providers', query],
    queryFn: () => api.getDashboardProviders(query),
    enabled: Boolean(query && enabled !== false),
    refetchInterval: sliding ? 30000 : false,
    staleTime: 5000,
    placeholderData: keepPreviousData,
  });

  // Dynamic plugins discovery for plugin-based OAuth channels like Codebuddy
  const { data: pluginsData } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 30000,
  });

  const pluginOAuthIds = useMemo(() => {
    const ids = new Set<string>();
    if (!pluginsData?.plugins) return ids;
    for (const plugin of pluginsData.plugins) {
      const keys = pluginOAuthProviderKeys(plugin);
      for (const key of keys) ids.add(key);
      if (keys.length && plugin.metadata?.name) {
        ids.add(plugin.metadata.name.toLowerCase().trim());
      }
    }
    return ids;
  }, [pluginsData]);

  // A plugin-registered provider's own logo replaces the mark the console would
  // otherwise resolve for it, including an operator-stored icon override.
  const pluginLogos = useMemo(() => pluginOAuthProviderLogos(pluginsData?.plugins), [pluginsData]);
  // Rows carry the names the OAuth page gives the same providers.
  const pluginTitles = useMemo(() => pluginOAuthProviderTitles(pluginsData?.plugins), [pluginsData]);

  const configuredProviders = providersData?.providers || [];
  const overviewProviders: ManagementOverviewProvider[] = overview.providers || [];
  // `undefined` while the auth-file read failed: an empty list would claim no OAuth credentials.
  const authFilesByType = overview.credentials ? (overview.credentials.by_type ?? []) : undefined;
  // If the windowed query failed with partial errors, avoid fabricating zero traffic and fall back to overview
  const windowProviders = windowProvidersData?.partial_errors?.length ? undefined : windowProvidersData?.providers;
  const windowCredentials = windowProvidersData?.partial_errors?.length ? undefined : windowProvidersData?.credentials;
  // The strip is drawn only on the grid the windowed read was answered on: the overview fallback
  // carries no buckets, and an empty strip would claim the providers sat idle.
  const fromMs = windowProvidersData?.window.from ?? 0;
  const toMs = windowProvidersData?.window.to ?? 0;
  const bucketMs = windowProvidersData?.bucket_ms ?? 0;
  const hasActivityGrid = Boolean(windowProviders);
  // Every row shares its window and clock. Resolve labels once, not per row or per tooltip.
  const activityLabels = useMemo(() => hasActivityGrid && !isPhone
    ? activityBlocks([], fromMs, toMs, bucketMs).map((block) => formatMinuteSpan(block.startMs, block.endMs, timeZone))
    : [], [hasActivityGrid, isPhone, fromMs, toMs, bucketMs, timeZone]);

  // Aggregated list: windowed traffic (or live overview fallback) + configured AI providers + OAuth channels
  const aggregated = useMemo<AggregatedProvider[]>(() => {
    return aggregateProviders({
      overviewProviders,
      windowProviders,
      windowCredentials,
      configuredProviders,
      customIcons,
      authFilesByType,
      pluginOAuthIds,
      pluginLogos,
      pluginTitles,
    });
  }, [overviewProviders, windowProviders, windowCredentials, configuredProviders, customIcons, authFilesByType, pluginOAuthIds, pluginLogos, pluginTitles]);

  // The operator's order replaces the volume sort for the rows it names; a provider it does not
  // name still lands by volume after them, and the fold keeps hiding the tail of that order.
  const sortable = useRankedSortableList(DASHBOARD_PROVIDER_ORDER_PREFERENCE, aggregated, providerRowKey);
  const ordered = sortable.ordered;
  const isFoldable = ordered.length > PROVIDER_PREVIEW_LIMIT;
  const visibleProviders = useMemo(() => {
    const visible = isFoldable && !isExpanded ? ordered.slice(0, PROVIDER_PREVIEW_LIMIT) : ordered;
    return visible.map((provider) => ({
      provider,
      blocks: hasActivityGrid && !isPhone ? activityBlocks(provider.buckets, fromMs, toMs, bucketMs) : [],
    }));
  }, [ordered, isFoldable, isExpanded, hasActivityGrid, isPhone, fromMs, toMs, bucketMs]);

  const handleRowClick = (provider: AggregatedProvider) => {
    if (provider.kind === 'oauth') {
      navigate(`/auth-files?provider=${encodeURIComponent(provider.id)}`);
    } else {
      const target = provider.providerId || provider.id;
      navigate(`/ai-providers?provider=${encodeURIComponent(target)}`);
    }
  };

  return (
    <section className="dashboard-section dashboard-providers-section">
      <SectionHeading level="section" as="h2" className="section-heading" title={t('dash.providers')} />

      {/* Full-width Aggregated Provider List Panel */}
      <div className="terminal-panel provider-list-panel">
        {aggregated.length === 0 ? (
          <EmptyState size="compact" title={t('dash.empty_providers')} />
        ) : (
          <RowReorder {...sortable.reorder} items={visibleProviders.map(({ provider }) => provider.key)}>
            <div className="provider-list-items">
              {visibleProviders.map(({ provider, blocks }) => (
                <ProviderRow
                  key={provider.key}
                  provider={provider}
                  blocks={blocks}
                  isPhone={isPhone}
                  hasActivityGrid={hasActivityGrid}
                  activityLabels={activityLabels}
                  onOpen={handleRowClick}
                />
              ))}
            </div>
          </RowReorder>
        )}
        {isFoldable && (
          <button
            type="button"
            className="provider-list-toggle"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((current) => !current)}
          >
            {isExpanded ? <UpOutlined aria-hidden="true" /> : <DownOutlined aria-hidden="true" />}
            {isExpanded
              ? t('dash.providers_show_less')
              : t('dash.providers_show_all', { n: ordered.length })}
          </button>
        )}
      </div>
    </section>
  );
});

interface ProviderRowProps {
  provider: AggregatedProvider;
  blocks: ReturnType<typeof activityBlocks>;
  isPhone: boolean;
  hasActivityGrid: boolean;
  activityLabels: string[];
  onOpen: (provider: AggregatedProvider) => void;
}

/** One provider's row: a link to where it is managed, and a place in the operator's order. */
function ProviderRow({ provider, blocks, isPhone, hasActivityGrid, activityLabels, onOpen }: ProviderRowProps) {
  const t = useT();
  const reorder = useReorderRow(provider.key);
  const isOAuth = provider.kind === 'oauth';
  // The window rate carries its band colour itself: the strip beside it colours each
  // bucket, and a phone does not draw the strip at all.
  const rateColor = RATE_TONE_COLOR[successRateTone(provider.successRate)];
  return (
    <div
      {...reorder.row}
      className="provider-row-enhanced is-clickable"
      onClick={() => onOpen(provider)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // The handle inside the row takes its own keys; Enter there must not open the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(provider);
        }
      }}
    >
      {!isPhone && <ReorderHandle {...reorder.handle} name={provider.name} />}
      {/* Brand Icon & Name */}
      <div className="provider-main-col">
        <div className="provider-brand-badge">
          <ProviderBrandIcon
            mark={provider}
            size={20}
            className="provider-brand-icon"
          />
          <span
            className={`status-pip ${provider.disabled ? 'is-disabled' : 'is-active'}`}
            title={provider.disabled ? t('dash.providers_status_disabled') : undefined}
          />
        </div>
        <div className="provider-title-line">
          <span className="provider-title">{provider.name}</span>
          {isOAuth && (
            <Tag size="small" tone="accent">{t('dash.providers_type_oauth')}</Tag>
          )}
          {provider.disabled && (
            <Tag size="small" tone="danger">{t('dash.providers_status_disabled')}</Tag>
          )}
          <RightOutlined className="provider-jump-arrow" aria-hidden="true" />
        </div>
      </div>

      {/* Credentials Count */}
      <div className="provider-creds-col">
        <span className="provider-credentials">
          {t('dash.credentials_n', { n: provider.credentials })}
        </span>
      </div>

      {/* Requests Total */}
      <div className="provider-total-col">
        <span className="provider-total">{formatCount(provider.total)}</span>
      </div>

      {/* Success Rate */}
      <div className="provider-rate-col">
        <span className="provider-rate" style={{ color: rateColor }}>
          {formatRate(provider.successRate)}
        </span>
        {isPhone && <ReorderHandle {...reorder.handle} name={provider.name} variant="inline" />}
      </div>

      {/* The rate across the window, bucket by bucket. A phone omits it: two dozen blocks
          in a phone's width are too narrow to read or to touch, and the rate stays. */}
      {!isPhone && (
        <div className="provider-visual-col">
          {hasActivityGrid && (
            <ProviderActivityStrip
              name={provider.name}
              blocks={blocks}
              labels={activityLabels}
            />
          )}
        </div>
      )}
    </div>
  );
}

function providerRowKey(provider: AggregatedProvider): string {
  return provider.key;
}
