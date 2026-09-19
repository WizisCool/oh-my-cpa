import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Tag } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { ProviderBrandIcon } from '../LobeIcon';
import { pluginOAuthProviderLogos } from '../../types/pluginOAuthProviders';
import { usePreference } from '../../hooks/usePreference';
import { parseProviderIcons, PROVIDER_ICONS_PREFERENCE } from '../../types/providerIcons';
import type { ManagementOverview, ManagementOverviewProvider } from '../../types/management';
import { isSlidingRange, type DashboardRange } from '../../types/dashboard';
import {
  aggregateProviders,
  type AggregatedProvider,
} from './dashboardProvidersLogic';
import { ProviderSparkline } from './ProviderSparkline';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

export interface DashboardProvidersProps {
  overview: ManagementOverview;
  query?: string;
  range?: DashboardRange;
  enabled?: boolean;
}

export const DashboardProviders: React.FC<DashboardProvidersProps> = ({
  overview,
  query,
  range,
  enabled,
}) => {
  const t = useT();
  const navigate = useNavigate();
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
    for (const p of pluginsData.plugins) {
      if (p.supports_oauth || p.oauth_provider) {
        if (p.id) ids.add(p.id.toLowerCase().trim());
        if (p.oauth_provider) ids.add(p.oauth_provider.toLowerCase().trim());
        if (p.name) ids.add(p.name.toLowerCase().trim());
      }
    }
    return ids;
  }, [pluginsData]);

  // A plugin-registered provider's own logo replaces the mark the console would
  // otherwise resolve for it, including an operator-stored icon override.
  const pluginLogos = useMemo(() => pluginOAuthProviderLogos(pluginsData?.plugins), [pluginsData]);

  const configuredProviders = providersData?.providers || [];
  const overviewProviders: ManagementOverviewProvider[] = overview.providers || [];
  const authFilesByType = overview.credentials?.by_type || [];
  // If the windowed query failed with partial errors, avoid fabricating zero traffic and fall back to overview
  const windowProviders = windowProvidersData?.partial_errors?.length ? undefined : windowProvidersData?.providers;

  // Aggregated list: windowed traffic (or live overview fallback) + configured AI providers + OAuth channels
  const aggregated = useMemo<AggregatedProvider[]>(() => {
    return aggregateProviders({
      overviewProviders,
      windowProviders,
      configuredProviders,
      customIcons,
      authFilesByType,
      pluginOAuthIds,
      pluginLogos,
    });
  }, [overviewProviders, windowProviders, configuredProviders, customIcons, authFilesByType, pluginOAuthIds, pluginLogos]);

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
      <div className="section-heading">
        <h2>{t('dash.providers')}</h2>
      </div>

      {/* Full-width Aggregated Provider List Panel */}
      <div className="terminal-panel provider-list-panel">
        {aggregated.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dash.empty_providers')} />
        ) : (
          <div className="provider-list-items">
            {aggregated.map((provider) => {
              const isOAuth = provider.kind === 'oauth';
              return (
                <div
                  className="provider-row-enhanced is-clickable"
                  key={provider.key}
                  onClick={() => handleRowClick(provider)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRowClick(provider);
                    }
                  }}
                >
                  {/* Brand Icon & Name */}
                  <div className="provider-main-col">
                    <div className="provider-brand-badge">
                      <ProviderBrandIcon
                        iconId={provider.iconId}
                        logo={provider.logo}
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
                        <Tag className="provider-badge is-oauth">{t('dash.providers_type_oauth')}</Tag>
                      )}
                      {provider.disabled && (
                        <Tag className="provider-badge is-disabled">{t('dash.providers_status_disabled')}</Tag>
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
                    <span className="provider-rate">{formatRate(provider.successRate)}</span>
                  </div>

                  {/* Sparkline Activity & Progress Meter (100% full width) */}
                  <div className="provider-visual-col">
                    <ProviderSparkline
                      buckets={provider.buckets}
                      total={provider.total}
                      failures={provider.failure}
                      successRate={provider.successRate}
                      height={18}
                    />
                    <div className="dashboard-meter">
                      <span style={{ width: `${Math.max(0, Math.min(100, provider.successRate ?? 0))}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
