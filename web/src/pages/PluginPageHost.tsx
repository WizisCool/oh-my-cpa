import React from 'react';
import { Button, Empty, Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../i18n';
import { getAppConfig } from '../types/config';
import { useTheme } from '../theme/ThemeContext';
import { ExternalLinkOutlined, ReloadOutlined, SettingOutlined } from '../components/icons';
import { PageLoading } from '../components/common/PageLoading';
import { LoadFailure } from '../components/feedback';
import { PluginLogo } from '../components/plugins/PluginParts';
import { collectPluginPages, findPluginPage, pluginFrameShell, pluginPageFrameURL } from '../components/plugins/pluginPages';
import styles from '../components/plugins/PluginPageHost.module.css';

/**
 * One page a plugin registered, shown inside the console.
 *
 * The page is the plugin's own document, so it is a frame rather than console markup: the
 * console supplies the place, the heading and the way back to the plugin's settings, and
 * the plugin supplies everything inside. The frame is same-origin with the console, as it
 * is in CPA's management centre, because plugin pages build their requests from
 * `location.origin` and read the host's colour scheme from their parent (ADR 0060).
 */
export const PluginPageHost: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { pluginId, pageIndex } = useParams();
  const { themeMode } = useTheme();
  const frameTheme: 'dark' | 'light' = themeMode === 'dark' ? 'dark' : 'light';
  const [reloadCount, setReloadCount] = React.useState(0);
  const [isFrameLoading, setIsFrameLoading] = React.useState(true);
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

  // The shell is written once per load. A later mode change updates its attribute in
  // place, which the plugin page observes; rebuilding the document would reload the page
  // and lose whatever the operator had open in it.
  const latestTheme = React.useRef(frameTheme);
  const shell = React.useMemo(
    () => (frameURL ? pluginFrameShell(frameURL, frameTitle, latestTheme.current) : ''),
    // A reload writes the shell again so it starts in the mode now in force.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameURL, frameTitle, reloadCount],
  );
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
    setIsFrameLoading(true);
  }, [shell, reloadCount]);

  if (pluginsQuery.isLoading) return <PageLoading variant="block" />;
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
        <Empty description={t('plugin.page_unavailable')}>
          <Button type="primary" onClick={() => navigate('/plugins')}>{t('plugin.page_open_management')}</Button>
        </Empty>
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
        {isFrameLoading && <PageLoading variant="block" className={styles.loading} />}
        <iframe
          key={`${entry.route}:${reloadCount}`}
          ref={shellRef}
          // Shown only once the plugin's document has loaded: until then the frame is the
          // browser's blank canvas, which flashes against the console's surface.
          className={`${styles.frame} ${isFrameLoading ? styles['frame-pending'] : ''}`}
          title={frameTitle}
          srcDoc={shell}
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          onLoad={() => {
            setIsFrameLoading(false);
            stateFrameTheme(frameTheme);
          }}
          data-plugin-page-frame
        />
      </div>
    </div>
  );
};
