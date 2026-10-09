import React from 'react';
import { Button, Card } from 'antd';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import type { ManagementOverview } from '../../types/management';
import { useT } from '../../i18n';
import { LoadFailure } from '../feedback';
import { LoadingRegion, Placeholder } from '../common/Placeholder';
import { RightOutlined } from '../icons';

export type CredentialHealthState = 'ready' | 'empty' | 'unknown' | 'loading';

export interface CredentialHealthProps {
  overview?: ManagementOverview | null;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * Maps live management overview state to credential health presentation.
 * Cached credentials stay visible during transient refresh errors.
 */
export function resolveCredentialHealthState({
  overview,
  isLoading,
}: {
  overview?: ManagementOverview | null;
  isLoading?: boolean;
  isError?: boolean;
}): CredentialHealthState {
  if (overview) {
    if (overview.credentials === null || overview.credentials === undefined) {
      return 'unknown';
    }
    return overview.credentials.total === 0 ? 'empty' : 'ready';
  }
  if (isLoading) return 'loading';
  return 'unknown';
}

/**
 * CredentialHealth displays live credential availability beside the activity heatmap.
 * Shows an additive warning on background refresh failure without dropping cached facts.
 */
export const CredentialHealth: React.FC<CredentialHealthProps> = ({
  overview,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  className,
}) => {
  const t = useT();
  const state = resolveCredentialHealthState({ overview, isLoading, isError });
  const credentials = overview?.credentials;

  return (
    <Card
      className={clsx('dashboard-tile credential-health-panel', className)}
      styles={{ body: { padding: 20 } }}
      data-testid="dashboard-credential-health"
      data-health-state={state}
    >
      <div className="health-inner">
        <div className="health-head">
          <span className="tile-label">{t('dash.health')}</span>
          {state === 'ready' && credentials && (
            <Link to="/oauth-management" className="health-head-link">
              <span>{t('oauth.view_auth_files')}</span>
              <RightOutlined className="health-link-icon" />
            </Link>
          )}
        </div>

        {state === 'loading' && (
          <LoadingRegion className="health-skeleton">
            <Placeholder width="100%" height={8} className="placeholder-line" />
            <div className="health-skeleton-legend">
              <Placeholder width="28%" height={14} className="placeholder-line is-meta" />
              <Placeholder width="32%" height={14} className="placeholder-line is-meta" />
              <Placeholder width="28%" height={14} className="placeholder-line is-meta" />
            </div>
            <div className="health-skeleton-types">
              <Placeholder width="24%" height={26} className="placeholder-line" />
              <Placeholder width="28%" height={26} className="placeholder-line" />
              <Placeholder width="22%" height={26} className="placeholder-line" />
            </div>
          </LoadingRegion>
        )}

        {state === 'unknown' && (
          <div className="health-body">
            {isError ? (
              <LoadFailure
                className="health-alert"
                title={t('dash.health_error')}
                error={error}
                onRetry={onRetry}
              />
            ) : (
              <div className="health-unavailable-block">
                <p className="empty-copy">{t('dash.health_unavailable')}</p>
                {onRetry && (
                  <div className="health-retry-action">
                    <Button size="small" onClick={onRetry}>
                      {t('common.retry')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {state === 'empty' && (
          <div className="health-body">
            {isError && (
              <LoadFailure
                className="health-alert health-stale-alert"
                tone="warning"
                title={t('dash.health_stale')}
                onRetry={onRetry}
              />
            )}
            <p className="empty-copy">{t('dash.health_empty')}</p>
            <div className="health-empty-action">
              <Link to="/oauth-management" className="health-action-link">
                <span>{t('oauth.view_auth_files')}</span>
                <RightOutlined className="health-link-icon" />
              </Link>
            </div>
          </div>
        )}

        {state === 'ready' && credentials && (
          <div className="health-body">
            {isError && (
              <LoadFailure
                className="health-alert health-stale-alert"
                tone="warning"
                title={t('dash.health_stale')}
                onRetry={onRetry}
              />
            )}
            <div
              className="health-meter"
              role="meter"
              aria-label={t('dash.health')}
              aria-valuemin={0}
              aria-valuemax={credentials.total}
              aria-valuenow={credentials.active}
            >
              <span
                className="health-active"
                style={{ flexGrow: credentials.active }}
                title={`${t('dash.legend_active')}: ${credentials.active}`}
              />
              <span
                className="health-unavailable"
                style={{ flexGrow: credentials.unavailable }}
                title={`${t('dash.legend_unavailable')}: ${credentials.unavailable}`}
              />
              <span
                className="health-disabled"
                style={{ flexGrow: credentials.disabled }}
                title={`${t('dash.legend_disabled')}: ${credentials.disabled}`}
              />
            </div>
            <div className="health-legend">
              <span>
                <i className="legend-dot success" />
                {t('dash.legend_active')} <b>{credentials.active}</b>
              </span>
              <span>
                <i className="legend-dot warning" />
                {t('dash.legend_unavailable')} <b>{credentials.unavailable}</b>
              </span>
              <span>
                <i className="legend-dot failure" />
                {t('dash.legend_disabled')} <b>{credentials.disabled}</b>
              </span>
            </div>
            {credentials.by_type && credentials.by_type.length > 0 && (
              <div className="type-list">
                {credentials.by_type.map((entry) => (
                  <span key={entry.type}>
                    {entry.type} <b>{entry.count}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};
