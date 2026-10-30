import React from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../i18n';
import { getAppConfig } from '../types/config';
import { useTheme } from '../theme/ThemeContext';
import { ExternalLinkOutlined, ReloadOutlined, SettingOutlined } from '../components/icons';
import { ListLoading } from '../components/common/PageLoading';
import { LoadFailure } from '../components/feedback';
import { PluginLogo } from '../components/plugins/PluginParts';
import { collectPluginPages, findPluginPage, pluginPageFrameURL } from '../components/plugins/pluginPages';
import styles from '../components/plugins/PluginPageHost.module.css';
import shellURL from '../components/plugins/pluginFrameShell.html?url&no-inline';
import { EmptyState } from '../components/common/EmptyState';
import { Tooltip } from '../components/common/Tooltip';

/**
 * One page a plugin registered, shown inside the console.
 *
 * The page is the plugin's own document, so it is a frame rather than console markup: the
 * console supplies the place, the heading and the way back to the plugin's settings, and
 * the plugin supplies everything inside. The frame is same-origin with the console, as it
 * is in CPA's management centre, because plugin pages build their requests from
 * `location.origin` and read the host's colour scheme from their parent.
 */
export const PluginPageHost: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { pluginId, pageIndex } = useParams();
  const { themeMode } = useTheme();
  const frameTheme: 'dark' | 'light' = themeMode === 'dark' ? 'dark' : 'light';
  const [reloadCount, setReloadCount] = React.useState(0);
  const [frameState, setFrameState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const isFrameLoading = frameState === 'loading';
  const shellRef = React.useRef<HTMLIFrameElement | null>(null);

  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 15000,
  });
  const entries = React.useMemo(() => collectPluginPages(pluginsQuery.data?.plugins), [pluginsQuery.data]);
  const entry = findPluginPage(entries, pluginId, pageIndex);

  const frameURL = entry ? pluginPageFrameURL(getAppConfig().apiBaseUrl, entry.resourcePath) : '';
  const frameTitle = entry?.navLabel ?? '';

  const latestTheme = React.useRef(frameTheme);
  const stateFrameTheme = React.useCallback((theme: 'dark' | 'light') => {
    const shellRoot = shellRef.current?.contentDocument?.documentElement;
    if (!shellRoot) return;
    shellRoot.setAttribute('data-theme', theme);
    shellRoot.style.colorScheme = theme;
  }, []);
  React.useEffect(() => {
    latestTheme.current = frameTheme;
    stateFrameTheme(frameTheme);
  }, [frameTheme, stateFrameTheme]);

  React.useEffect(() => {
    setFrameState('loading');
  }, [frameURL, frameTitle, reloadCount]);

  if (pluginsQuery.isLoading) return <ListLoading />;
  if (pluginsQuery.isError && !pluginsQuery.data) {
    return (
      <div className="terminal-page">
        <LoadFailure title={t('common.load_failed_title')} error={pluginsQuery.error} onRetry={() => void pluginsQuery.refetch()} />
      </div>
    );
  }
  if (!entry) {
    return (
      <div className={styles.unavailable} data-plugin-page-unavailable>
        <EmptyState title={t('plugin.page_unavailable')}>
          <Button type="primary" onClick={() => navigate('/plugins')}>{t('plugin.page_open_management')}</Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.page} data-plugin-page={entry.pluginId}>
      <div className={styles.bar}>
        <span className={styles.mark}><PluginLogo logo={entry.logo} /></span>
        <div className={styles.identity}>
          <span className={styles.title}>{entry.label}</span>
          <span className={styles.subtitle}>
            {entry.label !== entry.pluginName ? `${entry.pluginName} · ` : ''}
            {entry.description || t('plugin.page_provided_by_plugin')}
          </span>
        </div>
        <span className={styles.actions}>
          <Tooltip title={t('plugin.page_reload')}>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadCount((count) => count + 1)} aria-label={t('plugin.page_reload')} />
          </Tooltip>
          <Tooltip title={t('plugin.page_open_new_tab')}>
            <Button size="small" icon={<ExternalLinkOutlined />} href={frameURL} target="_blank" rel="noreferrer" aria-label={t('plugin.page_open_new_tab')} />
          </Tooltip>
          <Tooltip title={t('plugin.page_configure')}>
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => navigate(`/plugins?plugin=${encodeURIComponent(entry.pluginId)}`)}
              aria-label={t('plugin.page_configure')}
            />
          </Tooltip>
        </span>
      </div>
      <div className={styles.stage}>
        {frameState === 'failed' ? (
          <LoadFailure
            title={t('common.load_failed_title')}
            onRetry={() => setReloadCount((count) => count + 1)}
            data-testid="plugin-page-load-failure"
          />
        ) : (
          <>
            {isFrameLoading && <ListLoading className={styles.loading} />}
            <iframe
              key={`${entry.route}:${frameURL}:${frameTitle}:${reloadCount}`}
              ref={shellRef}
              // Shown only once the plugin's document has loaded: until then the frame is the
              // browser's blank canvas, which flashes against the console's surface.
              className={`${styles.frame} ${isFrameLoading ? styles['frame-pending'] : ''}`}
              title={frameTitle}
              src={shellURL}
              referrerPolicy="no-referrer"
              allow="clipboard-read; clipboard-write"
              onLoad={(event) => {
                // A network-loaded parent preserves CPA's theme contract without Firefox's
                // CSP misclassification of same-origin children inside srcdoc (issue #275).
                const pluginFrame = event.currentTarget.contentDocument?.querySelector('iframe');
                if (!pluginFrame) {
                  setFrameState('failed');
                  return;
                }
                stateFrameTheme(latestTheme.current);
                pluginFrame.title = frameTitle;
                pluginFrame.onload = () => {
                  setFrameState('ready');
                  stateFrameTheme(latestTheme.current);
                };
                pluginFrame.src = frameURL;
              }}
              data-plugin-page-frame
            />
          </>
        )}
      </div>
    </div>
  );
};
