import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Button,
  Tag,
  Typography,
  Alert,
  Spin,
  Modal,
  Drawer,
  Tooltip,
  App as AntdApp,
} from 'antd';
import {
  SyncOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  SafetyCertificateOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  LinkOutlined,
  RightOutlined,
  CloudDownloadOutlined,
  CompressOutlined,
  ClearOutlined,
  WarningOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import type {
  SystemInfoResponse,
  SystemProductVersion,
  SystemMaintenanceResponse,
  SystemMaintenanceStatus,
  ReleaseProduct,
} from '../types/system';
import styles from './SystemPage.module.css';

const { Text, Paragraph } = Typography;

/** Formats byte numbers into clean human-readable units. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const clampedI = Math.min(i, units.length - 1);
  const val = bytes / Math.pow(1024, clampedI);
  return `${val.toFixed(val >= 10 || clampedI === 0 ? 1 : 2)} ${units[clampedI]}`;
}




/** The merged change log for one product, rendered as a drawer's content. */
interface ProductChangelogProps {
  product: ReleaseProduct;
}

const ProductChangelog: React.FC<ProductChangelogProps> = ({ product }) => {
  const t = useT();

  // Fetched only when this component exists, which the drawer decides: a request feed is
  // rate limited, so nothing here may run for a reader who has not asked for the log.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['management-system-releases', product],
    queryFn: () => api.getSystemReleases(product),
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <Spin size="small" />
      </div>
    );
  }

  if (isError) {
    const msg = error instanceof ApiError ? error.message : String(error);
    return <Alert type="error" showIcon description={msg} />;
  }

  if (!data || data.releases.length === 0) {
    return <Text type="secondary">{t('sys.no_changelog_entries')}</Text>;
  }

  return (
    <div className={styles['changelog-panel']}>
      {!data.range_complete && (
        <Alert
          type="warning"
          showIcon
          description={t('sys.range_incomplete')}
        />
      )}

      {data.check_error && (
        <Alert
          type="error"
          showIcon
          description={data.check_error}
        />
      )}

      <div className={styles['changelog-header']}>
        <span>{t('sys.view_changelog', { count: data.releases.length })}</span>
        <a
          href={data.repository_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles['repo-link']}
          aria-label={t('sys.open_repo_link', { repo: data.repository })}
        >
          {data.repository} <LinkOutlined />
        </a>
      </div>

      {data.releases.map((release) => (
        <div key={release.tag} className={styles['release-entry']}>
          <div className={styles['release-title-row']}>
            <div className={styles['release-tag-group']}>
              <Tag color="default" style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                {release.tag}
              </Tag>
              {release.in_range && (
                <Tag color="processing">{t('sys.changelog_in_range')}</Tag>
              )}
              {release.name && release.name !== release.tag && (
                <Text strong style={{ fontSize: 13 }}>{release.name}</Text>
              )}
            </div>
            <div className={styles['release-meta']}>
              {release.published_at_ms > 0 && (
                <span>{dayjs(release.published_at_ms).format('YYYY-MM-DD')}</span>
              )}
              <Tooltip title={t('sys.view_release_on_github', { tag: release.tag })}>
                <a
                  href={release.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('sys.view_release_on_github', { tag: release.tag })}
                >
                  <LinkOutlined />
                </a>
              </Tooltip>
            </div>
          </div>

          {!release.body_available || !release.body ? (
            <div style={{ fontSize: 12, color: 'var(--meta)' }}>
              {t('sys.notes_unavailable')}
            </div>
          ) : (
            <div className={styles['markdown-body']}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      {children}
                    </a>
                  ),
                  img: ({ src, alt }) => (
                    <a
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles['image-link']}
                      aria-label={alt || src}
                    >
                      [{t('sys.image_link')}: {alt || src}]
                    </a>
                  ),
                }}
              >
                {release.body}
              </ReactMarkdown>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/** Product version block with status, repository link, and changelog toggle. */
interface ProductBlockProps {
  productTitle: string;
  version: SystemProductVersion;
  onOpenChangelog: () => void;
}

const ProductBlock: React.FC<ProductBlockProps> = ({
  productTitle,
  version,
  onOpenChangelog,
}) => {
  const t = useT();

  const renderStateBadge = () => {
    switch (version.state) {
      case 'update_available':
        return (
          <Tag color="blue">
            {t('sys.update_available', { version: version.latest_version || '' })}
          </Tag>
        );
      case 'up_to_date':
        return (
          <span className={styles['state-badge']}>
            <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>{t('sys.is_latest')}</Text>
          </span>
        );
      case 'update_ahead':
        return <Tag color="purple">{t('sys.update_ahead')}</Tag>;
      case 'indeterminate':
      default: {
        let reasonLabel = t('sys.indeterminate');
        if (version.reason === 'running_version_not_comparable') {
          reasonLabel = t('sys.reason_running_not_comparable');
        } else if (version.reason === 'newest_release_not_comparable') {
          reasonLabel = t('sys.reason_latest_not_comparable');
        } else if (version.reason === 'no_releases_published') {
          reasonLabel = t('sys.reason_no_releases');
        } else if (version.reason === 'not_checked_yet') {
          reasonLabel = t('sys.reason_not_checked');
        }
        return <Tag>{reasonLabel}</Tag>;
      }
    }
  };

  const hasNewer = version.state === 'update_available' || (version.merge_count > 0);

  return (
    <div className={styles['product-block']}>
      <div className={styles['product-header']} data-testid="sys-product-header">
        <div className={styles['product-identity']}>
          <div className={styles['product-title']}>{productTitle}</div>
          <a
            href={version.repository_url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles['repo-link']}
          >
            {version.repository} <LinkOutlined />
          </a>
        </div>
        <div className={styles['product-badge']}>{renderStateBadge()}</div>
      </div>

      <div className={styles['version-row']} data-testid="sys-version-row">
        <div>
          <Text type="secondary" style={{ marginRight: 6 }}>{t('sys.current_version')}:</Text>
          <Tag className={styles['version-tag']}>{version.running_version || t('sys.version_unknown')}</Tag>
        </div>
        {version.latest_version && (
          <div>
            <Text type="secondary" style={{ marginRight: 6 }}>{t('sys.latest_version')}:</Text>
            <span className={styles['version-tag']}>{version.latest_version}</span>
          </div>
        )}
      </div>

      {hasNewer && (
        <div className={styles['changelog-toggle']}>
          <Button
            type="link"
            size="small"
            icon={<RightOutlined />}
            onClick={onOpenChangelog}
          >
            {t('sys.view_changelog', { count: version.merge_count || 1 })}
          </Button>
        </div>
      )}

      {/* No routine "last checked" readout: it is the same timestamp on every card and it
          answered a question nobody asked. What remains is the one state a reader cannot infer
          from the card - that no release notes were retrieved, which is normal after a restart
          and would otherwise look like an empty change log.
          It is suppressed while a check error is shown: the notes are missing because that
          check failed, and a second sentence about missing notes beside the real reason would
          send the reader looking for a retrieval problem instead of a feed problem. */}
      {!version.notes_available && !version.check_error && (
        <div className={styles['product-meta']}>
          <Text type="secondary">{t('sys.notes_not_held')}</Text>
        </div>
      )}

      {version.check_error && (
        <Alert
          type="warning"
          showIcon
          style={{ fontSize: 12 }}
          description={t('sys.last_check_failed', {
            time: version.attempted_at_ms ? dayjs(version.attempted_at_ms).format('YYYY-MM-DD HH:mm:ss') : '—',
            msg: version.check_error,
          })}
        />
      )}

    </div>
  );
};

export const SystemPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [downloadingDiag, setDownloadingDiag] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  // The action currently being submitted, so only its own button spins.
  const [submittingAction, setSubmittingAction] = useState<'checkpoint' | 'vacuum' | null>(null);
  // Polling follows the job the server reports, not the request that started it: a
  // job outlives the response that accepted it, and its terminal state is what ends
  // the poll.
  const [isPollingMaintenance, setIsPollingMaintenance] = useState(false);
  const [isVacuumModalOpen, setIsVacuumModalOpen] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState<ReleaseProduct | null>(null);
  // The completed outcome the page shows, which is deliberately not the server's last job.
  // The server retains its terminal record for the life of the process, so rendering that
  // directly would pin the panel to a result from a previous session - one the reader cannot
  // clear, because every reload re-reads it. This snapshot is set only for a job this page
  // actually observed finish, and clearing it is local and therefore permanent for the reader.
  const [displayedOutcome, setDisplayedOutcome] = useState<SystemMaintenanceStatus | null>(null);

  const hasMountedCheckRef = useRef(false);
  // The last job completion already reported, so a terminal status is handled once rather than on
  // every effect run that still reads it. It is the job's identity - the server's action and start
  // instant - rather than `finished_at_ms`: this effect re-runs when the reading language changes,
  // because `t` is one of its dependencies, and recognising the same job there is what keeps a
  // result the reader dismissed from being restored.
  const reportedCompletionRef = useRef<{ action: string; startedAtMS: number } | null>(null);
  // The job this page is observing, identified by the server's own action name and start
  // instant. A terminal status is accepted only when it matches, because the query cache can
  // still hold an earlier job's terminal record.
  const observedJobRef = useRef<{ action: string; startedAtMS: number } | null>(null);

  // The action label shown inside a message, resolved from the action the server
  // reported rather than the one that was requested.
  const actionLabel = (action: string) => {
    if (action === 'vacuum') return t('sys.action_vacuum_short');
    if (action === 'checkpoint' || action === 'wal_checkpoint') return t('sys.action_checkpoint_short');
    return action;
  };

  const {
    data: sysInfo,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<SystemInfoResponse>({
    queryKey: ['management-system-info'],
    queryFn: api.getSystemInfo,
    staleTime: 15000,
  });

  // A running job reported by the page's own read is adopted and polled to its end: a job
  // admitted before this page was opened, or admitted elsewhere while it is open, is real work
  // holding the write gate, and the reader should see its outcome when it stops.
  //
  // Only a *running* job is adopted. A terminal record the server still holds is a result from
  // an earlier session, and adopting it would both show it on a fresh load and make it
  // impossible to clear, because every reload would adopt it again.
  //
  // Re-adopting the job already being observed is skipped, so repeated refetches of the same
  // running job cannot restart a poll that is already following it.
  useEffect(() => {
    const job = sysInfo?.maintenance;
    if (!job || !job.running) return;
    const observed = observedJobRef.current;
    if (observed && observed.action === job.action && observed.startedAtMS === job.started_at_ms) return;
    observedJobRef.current = { action: job.action, startedAtMS: job.started_at_ms };
    setIsPollingMaintenance(true);
  }, [sysInfo?.maintenance]);

  const { data: maintenanceData } = useQuery<SystemMaintenanceResponse>({
    queryKey: ['management-system-maintenance'],
    queryFn: api.getSystemMaintenance,
    refetchInterval: isPollingMaintenance ? 2000 : false,
    enabled: isPollingMaintenance,
  });

  // The polled response is authoritative only while polling: it is the live job, and it is
  // fresher than the page's own snapshot. Once polling stops, that response is the previous
  // job's terminal state, and letting it win thereafter would pin the panel to a job the
  // operator has since moved past - including after a later page refresh reported a newer one.
  const polledMaintenance = isPollingMaintenance ? maintenanceData : undefined;
  const effectiveMaintenance = polledMaintenance?.maintenance ?? sysInfo?.maintenance;
  const effectiveAdmission = polledMaintenance?.maintenance_admission ?? sysInfo?.maintenance_admission;
  const isMaintenanceActive = Boolean(effectiveMaintenance?.running || submittingAction !== null);

  // Establish a job as being observed by this page. A POST's 202 is the usual source, but a
  // server snapshot that already reports it running counts too: the job may have been admitted
  // by another tab, and the reader watching it should see its outcome when it ends.
  //
  // A response that is already terminal is registered the same way rather than reported here: a
  // checkpoint can finish before the response that accepted it arrives, the accepted response is
  // written into the maintenance cache, and the terminal effect below then classifies it exactly
  // as it classifies a polled result - one path, so an outcome cannot be reported two ways.
  const handleAcceptedJob = (job: SystemMaintenanceStatus) => {
    observedJobRef.current = { action: job.action, startedAtMS: job.started_at_ms };
    setIsPollingMaintenance(job.running);
  };

  // The terminal state ends the poll, refreshes the storage numbers it just moved,
  // and reports what actually happened.
  useEffect(() => {
    const job = maintenanceData?.maintenance;
    if (!job || job.running || job.finished_at_ms <= 0) return;

    // A terminal status is accepted only for the job this page is observing. The query cache
    // can still hold an earlier job's terminal record, and letting that one stop the poll or
    // set the outcome would report a finished job's numbers as this job's result.
    const observed = observedJobRef.current;
    if (!observed || observed.action !== job.action || observed.startedAtMS !== job.started_at_ms) return;

    // The poll stops on the terminal state, whether or not this page already reported it.
    // Returning early for an already-announced job would leave the poll running forever
    // against a job that is never going to change again.
    setIsPollingMaintenance(false);

    // A job's terminal state is handled once. The guard sits *before* the outcome is set, not after
    // it: this effect re-runs when the reading language changes, and the terminal record is still
    // in the query cache then, so setting the outcome first would put back a result the reader had
    // dismissed - which reads as the panel having restored itself.
    const reported = reportedCompletionRef.current;
    if (reported && reported.action === job.action && reported.startedAtMS === job.started_at_ms) return;
    reportedCompletionRef.current = { action: job.action, startedAtMS: job.started_at_ms };

    setDisplayedOutcome(job);
    void queryClient.invalidateQueries({ queryKey: ['management-system-info'] });

    const label = actionLabel(job.action);
    if (job.error) {
      message.error(t('sys.maintenance_failed', { action: label, msg: job.error }));
    } else if (job.incomplete) {
      // The statement ran but did not fully do its job, which is a different claim from
      // success and from failure.
      message.warning(
        t('sys.maintenance_incomplete_warning', {
          detail: job.detail || t('sys.maintenance_incomplete_default'),
        }),
      );
    } else {
      message.success(t('sys.maintenance_success', { action: label }));
    }
  }, [maintenanceData, queryClient, message, t]);

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    try {
      const outcome = await api.checkUpdates();
      // The feed is a shared per-address budget, so a check inside the floor is answered from
      // the stored index. Saying "already up to date" there would claim a check that did not
      // happen; saying when the stored answer is from is the honest report.
      if (outcome.served_from_cache) {
        message.info(t('sys.check_updates_cached'));
      } else {
        message.success(t('sys.check_updates_success'));
      }
      await queryClient.invalidateQueries({ queryKey: ['management-system-info'] });
      await queryClient.invalidateQueries({ queryKey: ['management-system-releases'] });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('sys.last_check_failed', { time: dayjs().format('HH:mm:ss'), msg }));
      await queryClient.invalidateQueries({ queryKey: ['management-system-info'] });
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  // A real check on page load, which is a deliberate product decision rather than an
  // oversight: the page exists to answer "is there a newer version", and a cached
  // answer that is never refreshed cannot. The demonstration is excluded because its
  // server refuses the route: the fixture already supplies the index, so checking there
  // would spend a request to receive a refusal.
  useEffect(() => {
    // Waiting for the page's own response, because whether this deployment allows an automatic
    // check is a server decision: the switch exists so that opening a page cannot spend requests
    // from a budget shared per address, and a page that checked regardless would defeat it.
    //
    // The decision is marked as taken only once there is a response to decide on. Setting the ref
    // on a failed first load would consume it while `sysInfo` was undefined, so a later successful
    // refresh could never perform the check this deployment had authorised.
    if (!sysInfo || hasMountedCheckRef.current) return;
    hasMountedCheckRef.current = true;
    if (!isDemo && sysInfo.update_check_on_page_load) {
      void handleCheckUpdates();
    }
  }, [isDemo, sysInfo]);

  const handleRunCheckpoint = async () => {
    setSubmittingAction('checkpoint');
    try {
      const accepted = await api.runSystemMaintenance('checkpoint');
      // 202 means the job was admitted, not that it finished. Saying "started" is the
      // honest reading, and the outcome arrives with the terminal status.
      queryClient.setQueryData(['management-system-maintenance'], accepted);
      message.info(t('sys.maintenance_started', { action: actionLabel('checkpoint') }));
      handleAcceptedJob(accepted.maintenance);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('sys.maintenance_failed', { action: actionLabel('checkpoint'), msg }));
    } finally {
      setSubmittingAction(null);
    }
  };

  const handleRunVacuum = async () => {
    setIsVacuumModalOpen(false);
    setSubmittingAction('vacuum');
    try {
      const accepted = await api.runSystemMaintenance('vacuum');
      queryClient.setQueryData(['management-system-maintenance'], accepted);
      message.info(t('sys.maintenance_started', { action: actionLabel('vacuum') }));
      handleAcceptedJob(accepted.maintenance);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('sys.maintenance_failed', { action: actionLabel('vacuum'), msg }));
    } finally {
      setSubmittingAction(null);
    }
  };

  const handleDownloadDiagnostics = async () => {
    setDownloadingDiag(true);
    try {
      const blob = await api.downloadSystemDiagnostics();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `omc-diagnostics-${Date.now()}.json`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      message.success(t('sys.download_success'));
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('sys.download_failed', { msg }));
    } finally {
      setDownloadingDiag(false);
    }
  };

  // The change log opens as an overlay rather than expanding inside the card: a merged log
  // across several releases is long enough that growing the card would push the rest of the
  // page off screen, and an overlay is what the rest of the console uses for content that
  // takes over the reading position.
  const closeChangelog = () => setExpandedProduct(null);
  useOverlayHistory({ isOpen: expandedProduct !== null, onClose: closeChangelog });

  // The product whose log the drawer renders, retained across the close so the exit animation has
  // something to draw. `expandedProduct` cannot serve: it goes null the moment the close begins, so
  // the panel would blank mid-animation and its title would fall back to the other product. A ref
  // holds the last non-null value; the comment above `open` exists because `open` and this are
  // deliberately different values, not the same one under two names.
  const lastChangelogProductRef = useRef<ReleaseProduct | null>(null);
  if (expandedProduct !== null) lastChangelogProductRef.current = expandedProduct;
  const changelogProduct = expandedProduct ?? lastChangelogProductRef.current;

  if (isLoading) {
    return (
      <div className="terminal-page system-page" style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className={`terminal-page system-page ${styles['system-page']}`}>
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('sys.title')}</h1>
          <p className="terminal-subtitle">{t('sys.subtitle')}</p>
        </div>

        <div className={styles['header-actions']}>
          <Button
            size="small"
            icon={<SyncOutlined spin={isFetching} />}
            disabled={isFetching}
            onClick={() => {
              // A refresh clears a completed result the reader has moved past, and never touches a
              // running job: that one is live server state, and the panel below keeps showing it.
              setDisplayedOutcome(null);
              void refetch();
              void queryClient.invalidateQueries({ queryKey: ['management-system-maintenance'] });
            }}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          description={error instanceof ApiError ? error.message : String(error)}
        />
      )}

      {/* 2x2 Grid of the 4 System Information cards */}
      <div className={styles['system-grid']}>
        {/* Card 1: Versions & Updates */}
        <Card
          className={styles['system-card']}
          data-testid="sys-card-versions"
          title={
            <div className={styles['card-head']} data-testid="sys-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <DashboardOutlined />
                <span>{t('sys.version_card')}</span>
              </div>
              {/* The check lives on the card it acts on: it refreshes the versions below
                  it, and a page-level button that changed one card was a control placed
                  away from its own effect. */}
              <Button
                type="link"
                size="small"
                icon={<CloudDownloadOutlined spin={isCheckingUpdates} />}
                loading={isCheckingUpdates}
                // The demonstration refuses this route on the server, so the control is
                // disabled rather than offered: a button whose only outcome is a refusal
                // teaches the reader something untrue about the product.
                disabled={isDemo || isCheckingUpdates}
                title={isDemo ? t('demo.blocked') : undefined}
                onClick={() => void handleCheckUpdates()}
              >
                {isCheckingUpdates ? t('sys.checking_updates') : t('sys.check_updates')}
              </Button>
            </div>
          }
        >
          {sysInfo && (
            <>
              <ProductBlock
                productTitle={t('sys.omc_version')}
                version={sysInfo.omc_version}
                onOpenChangelog={() => setExpandedProduct('omc')}
              />
              <ProductBlock
                productTitle={t('sys.cpa_version')}
                version={sysInfo.cpa_version}
                onOpenChangelog={() => setExpandedProduct('cpa')}
              />
            </>
          )}
        </Card>

        {/* Card 2: SQLite Storage */}
        <Card
          className={styles['system-card']}
          data-testid="sys-card-storage"
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <DatabaseOutlined />
              <span>{t('sys.storage_card')}</span>
            </div>
          }
        >
          {sysInfo && (
            <>
              <div className={styles['storage-headline']}>
                <span className={styles['storage-headline-label']}>{t('sys.storage_total')}</span>
                <span className={styles['storage-total-num']}>
                  {formatBytes(sysInfo.database.files.total_bytes)}
                </span>
              </div>

              <div className={styles['storage-file-list']} data-testid="sys-storage-file-list">
                <div className={styles['storage-file-row']} data-testid="sys-storage-file-row">
                  <span className={styles['storage-file-name']}>{t('sys.storage_main')}</span>
                  <span className={styles['storage-file-val']}>
                    {sysInfo.database.files.main_exists
                      ? formatBytes(sysInfo.database.files.main_bytes)
                      : t('sys.file_not_exist')}
                  </span>
                </div>

                <div className={styles['storage-file-row']} data-testid="sys-storage-file-row">
                  <span className={styles['storage-file-name']}>{t('sys.storage_wal')}</span>
                  <span className={styles['storage-file-val']}>
                    {sysInfo.database.files.wal_exists
                      ? formatBytes(sysInfo.database.files.wal_bytes)
                      : t('sys.file_not_exist')}
                  </span>
                </div>

                <div className={styles['storage-file-row']} data-testid="sys-storage-file-row">
                  <span className={styles['storage-file-name']}>{t('sys.storage_shm')}</span>
                  <span className={styles['storage-file-val']}>
                    {sysInfo.database.files.shm_exists
                      ? formatBytes(sysInfo.database.files.shm_bytes)
                      : t('sys.file_not_exist')}
                  </span>
                </div>
              </div>

              {/* What the file is, rather than how it is organised internally: the
                  observed journal mode, the schema generation, and the space in use. Page
                  geometry, free pages and the connection's own settings are in the
                  redacted diagnostics bundle for anyone who needs them. */}
              <div className={styles['storage-facts-section']} data-testid="sys-storage-facts">
                <div className={styles['storage-fact-row']} data-testid="sys-storage-fact-row">
                  <span className={styles['storage-fact-label']}>{t('sys.journal_mode')}</span>
                  <span className={styles['storage-fact-val']}>
                    {(sysInfo.database.journal_mode || '—').toUpperCase()}
                  </span>
                </div>
                <div className={styles['storage-fact-row']} data-testid="sys-storage-fact-row">
                  <span className={styles['storage-fact-label']}>{t('sys.schema_version')}</span>
                  <span className={styles['storage-fact-val']}>v{sysInfo.database.schema_version}</span>
                </div>
                <div className={styles['storage-fact-row']} data-testid="sys-storage-fact-row">
                  <span className={styles['storage-fact-label']}>{t('sys.used_bytes')}</span>
                  <span className={styles['storage-fact-val']}>
                    {formatBytes(sysInfo.database.used_bytes)}
                  </span>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* Card 3: Component Topology & Health */}
        <Card
          className={styles['system-card']}
          data-testid="sys-card-health"
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CloudServerOutlined />
              <span>{t('sys.topology_card')}</span>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* CPA Gateway */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('sys.component_cpa')}</div>
                <div style={{ fontSize: 12, color: 'var(--meta)', fontFamily: 'monospace' }}>
                  {sysInfo?.cpa.endpoint_masked}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {sysInfo?.cpa.status === 'connected' ? (
                  <Tag color="success" icon={<CheckCircleOutlined />}>
                    {sysInfo.cpa.latency_ms > 0
                      ? t('sys.cpa_latency', { ms: sysInfo.cpa.latency_ms })
                      : t('shell.connected')}
                  </Tag>
                ) : (
                  <Tag color="error" icon={<CloseCircleOutlined />}>
                    {t('shell.offline')}
                  </Tag>
                )}
              </div>
            </div>

            {/* SQLite DB */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('sys.component_db')}</div>
                <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                  {t('sys.db_mode', {
                    mode: (sysInfo?.database.journal_mode || '').toUpperCase() || '—',
                  })}
                </div>
              </div>
              <div>
                {sysInfo?.database.status === 'ok' ? (
                  <Tag color="success">{t('inst.db_ok')}</Tag>
                ) : (
                  <Tag color="error">{t('inst.db_error')}</Tag>
                )}
              </div>
            </div>

            {/* Collector */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('sys.component_collector')}</div>
                <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                  {t('sys.collector_mode', {
                    mode: sysInfo?.collector.mode || 'auto',
                    gaps: sysInfo?.collector.gap_count || 0,
                  })}
                </div>
              </div>
              <div>
                <Tag color={sysInfo?.collector.status === 'active' ? 'processing' : 'default'}>
                  {sysInfo?.collector.status === 'active'
                    ? t('sys.collector_status_active')
                    : t('sys.collector_status_disabled')}
                </Tag>
              </div>
            </div>
          </div>
        </Card>

        {/* Card 4: Maintenance & Diagnostics */}
        <Card
          className={styles['system-card']}
          data-testid="sys-card-maintenance"
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SafetyCertificateOutlined />
              <span>{t('sys.maintenance_card')}</span>
            </div>
          }
        >
          {/* Actions Bar */}
          <div className={styles['maintenance-actions']}>
            <Tooltip title={t('sys.checkpoint_desc')}>
              <Button
                icon={<ClearOutlined />}
                loading={
                  submittingAction === 'checkpoint' ||
                  (effectiveMaintenance?.running &&
                    (effectiveMaintenance.action === 'checkpoint' || effectiveMaintenance.action === 'wal_checkpoint'))
                }
                disabled={isDemo || isMaintenanceActive}
                onClick={() => void handleRunCheckpoint()}
              >
                {t('sys.action_checkpoint')}
              </Button>
            </Tooltip>

            <Tooltip
              title={
                effectiveAdmission && !effectiveAdmission.allowed
                  ? t('sys.vacuum_disabled_reason', { reason: effectiveAdmission.reason })
                  : t('sys.vacuum_desc')
              }
            >
              <Button
                icon={<CompressOutlined />}
                loading={
                  submittingAction === 'vacuum' ||
                  (effectiveMaintenance?.running && effectiveMaintenance.action === 'vacuum')
                }
                disabled={isDemo || isMaintenanceActive || (effectiveAdmission ? !effectiveAdmission.allowed : false)}
                onClick={() => setIsVacuumModalOpen(true)}
              >
                {t('sys.action_vacuum')}
              </Button>
            </Tooltip>

            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloadingDiag}
              disabled={isDemo}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={() => void handleDownloadDiagnostics()}
            >
              {t('sys.download_diag')}
            </Button>
          </div>

          {/* The running job, from the live server status. It is always shown, including one
              that was already running when the page was opened, and it is never dismissible:
              the page must not let a reader hide a job that is still holding the write gate. */}
          {effectiveMaintenance?.running && (
            <Alert
              type="info"
              showIcon
              icon={<Spin size="small" />}
              style={{ marginBottom: 16 }}
              description={t('sys.maintenance_in_progress', { action: actionLabel(effectiveMaintenance.action) })}
            />
          )}

          {/* The completed outcome, rendered from this page's own snapshot rather than from the
              server's retained last job. The server keeps that record for the life of the process,
              so rendering it directly would resurrect a result the reader has already cleared on
              every reload. */}
          {!effectiveMaintenance?.running && displayedOutcome && (
            <div className={styles['maintenance-box']} data-testid="sys-maintenance-outcome">
              <div className={styles['maintenance-box-title']}>
                {displayedOutcome.error ? (
                  <CloseCircleOutlined style={{ color: 'var(--ant-color-error)' }} />
                ) : displayedOutcome.incomplete ? (
                  // A partial result is its own outcome, not a qualified success. SQLite reports
                  // a blocked checkpoint in the statement's result row rather than as an error,
                  // so a green checkmark here would claim the log was truncated when it was not.
                  <WarningOutlined style={{ color: 'var(--ant-color-warning)' }} />
                ) : (
                  <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />
                )}
                <span>
                  {displayedOutcome.error
                    ? t('sys.maintenance_failed', {
                        action: actionLabel(displayedOutcome.action),
                        msg: displayedOutcome.error,
                      })
                    : displayedOutcome.incomplete
                      ? t('sys.maintenance_incomplete_title', {
                          action: actionLabel(displayedOutcome.action),
                        })
                      : t('sys.maintenance_success', { action: actionLabel(displayedOutcome.action) })}
                </span>
                <Button
                  type="text"
                  // The console's square row-action size, not `small`: a 28px control gains only 36px
                  // from the coarse-pointer 4px hit inset, and the floor this console measures is
                  // ~40px. The drawn box is what a finger has to hit here.
                  className={styles['maintenance-box-close']}
                  icon={<CloseOutlined />}
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  onClick={() => setDisplayedOutcome(null)}
                />
              </div>

              <div className={styles['maintenance-box-meta']}>
                {t('sys.maintenance_reclaimed', {
                  before: formatBytes(displayedOutcome.size_before_bytes),
                  after: formatBytes(displayedOutcome.size_after_bytes),
                  reclaimed: formatBytes(displayedOutcome.reclaimed_bytes),
                })}
              </div>

              {displayedOutcome.detail && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {displayedOutcome.detail}
                </Text>
              )}

              {displayedOutcome.incomplete && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 6 }}
                  description={t('sys.maintenance_incomplete_warning', {
                    detail: displayedOutcome.detail || t('sys.maintenance_incomplete_default'),
                  })}
                />
              )}

              {displayedOutcome.error && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginTop: 6 }}
                  description={displayedOutcome.error}
                />
              )}
            </div>
          )}

          <div className={styles['maintenance-notice']}>
            <p>{t('sys.maintenance_restart_notice')}</p>
            <p style={{ margin: 0 }}>{t('sys.diag_desc')}</p>
          </div>
        </Card>
      </div>

      {/* The change log drawer. Its title names the product it belongs to, because the two
          logs are identical in shape and a reader who opened one must be able to tell which
          one they are looking at. */}
      <Drawer
        open={expandedProduct !== null}
        onClose={closeChangelog}
        // `size` rather than `width`: antd declares `size?: sizeType | number | string`, and a string
        // here is applied as the panel's own `width` style - measured at exactly 760px on a desktop
        // viewport and 390px on a phone. It also matches the two other drawers in this console, which
        // use the same spelling. A reviewer has twice read this as an invalid prop; the type and the
        // rendered geometry are what settle it.
        size="min(760px, 100vw)"
        title={t('sys.changelog_title', {
          product: changelogProduct === 'cpa' ? t('sys.cpa_version') : t('sys.omc_version'),
        })}
      >
        {changelogProduct && <ProductChangelog product={changelogProduct} />}
      </Drawer>

      {/* VACUUM Confirmation Modal */}
      <Modal
        title={t('sys.vacuum_confirm_title')}
        open={isVacuumModalOpen}
        onCancel={() => setIsVacuumModalOpen(false)}
        onOk={() => void handleRunVacuum()}
        confirmLoading={submittingAction === 'vacuum'}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div className={styles['vacuum-modal-content']}>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            {t('sys.vacuum_confirm_desc')}
          </Paragraph>

          <div className={styles['vacuum-space-table']}>
            <div className={styles['vacuum-space-row']}>
              <span>{t('sys.storage_main')}</span>
              <span>{formatBytes(sysInfo?.database.files.main_bytes)}</span>
            </div>
            <div className={styles['vacuum-space-row']}>
              <span>{t('sys.vacuum_required_label')}</span>
              <span>{formatBytes(effectiveAdmission?.required_bytes)}</span>
            </div>
            <div className={styles['vacuum-space-row']}>
              <span>{t('sys.vacuum_available_label')}</span>
              <span>{formatBytes(effectiveAdmission?.available_bytes)}</span>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};
