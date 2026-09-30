import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from '../../utils/time';
import XMarkdown from '@ant-design/x-markdown';
import { LinkOutlined } from '../icons';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import type { ReleaseProduct } from '../../types/system';
import { PageLoading } from '../common/PageLoading';
import styles from '../../pages/SystemPage.module.css';
import { LoadFailure, Notice } from '../feedback';

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
              <Tag className={styles['release-tag']}>{release.tag}</Tag>
              {release.in_range && (
                <Tag color="processing">{t('sys.changelog_in_range')}</Tag>
              )}
              {release.name && release.name !== release.tag && (
                <Text strong className={styles['release-name']}>{release.name}</Text>
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
        </div>
      ))}
    </div>
  );
};

