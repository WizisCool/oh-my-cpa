import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from '../../utils/time';
import XMarkdown from '@ant-design/x-markdown';
import { ArrowRightOutlined, LinkOutlined } from '../icons';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import type { ReleaseProduct } from '../../types/system';
import { PageLoading } from '../common/PageLoading';
import styles from '../../pages/SystemPage.module.css';
import { LoadFailure, Notice } from '../feedback';
import { Tooltip } from '../common/Tooltip';

const { Text } = Typography;

/** The merged change log for one product, rendered as a drawer's content. */
interface ProductChangelogProps {
  product: ReleaseProduct;
}

export const ProductChangelog: React.FC<ProductChangelogProps> = ({ product }) => {
  useTimeZone();
  const t = useT();

  // Fetched only when this component exists, which the drawer decides: a request feed is
  // rate limited, so nothing here may run for a reader who has not asked for the log.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['management-system-releases', product],
    queryFn: () => api.getSystemReleases(product),
    staleTime: 60000,
  });

  if (isLoading) return <PageLoading variant="block" />;

  if (isError) {
    return <LoadFailure title={t('common.load_failed_title')} error={error} onRetry={() => void refetch()} />;
  }

  if (!data || data.releases.length === 0) {
    return <Text type="secondary">{t('sys.no_changelog_entries')}</Text>;
  }

  return (
    <div className={styles['changelog-panel']}>
      {!data.range_complete && (
        <Notice
          tone="warning"
          description={t('sys.range_incomplete')}
        />
      )}

      {data.check_error && (
        <Notice
          tone="error"
          description={data.check_error}
        />
      )}

      {/* The range the log spans, from the build that is running to the newest release, with the
          repository it was read from. The drawer title already names the product. */}
      <div className={styles['changelog-summary']}>
        <div className={styles['changelog-range']}>
          {data.running_version && data.latest_version && (
            <span className={styles['changelog-versions']}>
              {data.running_version}
              <ArrowRightOutlined aria-hidden="true" />
              <span className={styles['version-target']}>{data.latest_version}</span>
            </span>
          )}
          <span className={styles['changelog-count-label']}>{t('sys.changelog_count', { count: data.releases.length })}</span>
        </div>
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

      <ol className={styles['release-timeline']}>
        {data.releases.map((release) => (
          <li key={release.tag} className={styles['release-entry']}>
            {/* A release between the running build and the newest one is what an upgrade brings;
                its node takes the accent, and the rest of the log stays in the rail's ink. */}
            <span
              className={`${styles['release-node']} ${release.in_range ? styles['release-node-in-range'] : ''}`}
              role={release.in_range ? 'img' : undefined}
              aria-label={release.in_range ? t('sys.changelog_in_range') : undefined}
              aria-hidden={release.in_range ? undefined : true}
            />
            <div className={styles['release-title-row']}>
              <div className={styles['release-tag-group']}>
                <span className={styles['release-tag']}>{release.tag}</span>
                {release.name && release.name !== release.tag && (
                  <span className={styles['release-name']}>{release.name}</span>
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
              <div className={styles['release-notes-missing']}>{t('sys.notes_unavailable')}</div>
            ) : (
              <div className={styles['markdown-body']}>
                <XMarkdown
                  content={release.body}
                  escapeRawHtml
                  openLinksInNewTab
                  components={{
                    a: ({ href, children, domNode: _d, streamStatus: _s, ...props }: any) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} {...props}>
                        {children}
                      </a>
                    ),
                    img: ({ src, alt, domNode: _d, streamStatus: _s }: any) => (
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
                />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
};

