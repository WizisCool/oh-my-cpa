import React from 'react';
import { Button, Card } from 'antd';
import { useRouteError } from 'react-router-dom';
import { ReloadOutlined } from '../icons';
import { BrandArtwork } from './BrandArtwork';
import { CopyButton } from './CopyButton';
import { FactList } from './FactList';
import { PanelTitle } from './PanelTitle';
import { StatusLabel } from './StatusLabel';
import { useT } from '../../i18n';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { getAppConfig } from '../../types/config';
import { createRouteErrorDiagnostics, formatRouteErrorReport } from '../../utils/routeErrorDiagnostics';
import styles from './RouteErrorPage.module.css';

export const RouteErrorPage: React.FC = () => {
  const t = useT();
  const error = useRouteError();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const { basePath, version } = getAppConfig();
  const dashboardPath = `${basePath.replace(/\/+$/, '')}/dashboard`;
  const diagnostics = React.useMemo(() => createRouteErrorDiagnostics(error, {
    routePath: window.location.pathname,
    version: version ?? '',
    occurredAt: new Date().toISOString(),
  }), [error, version]);
  useDocumentTitle(t('route_error.title'));

  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const unavailable = t('route_error.unavailable');
  const facts = [
    { key: 'type', label: t('route_error.type'), value: diagnostics.errorType || unavailable },
    { key: 'route', label: t('route_error.route'), value: diagnostics.routePath },
    { key: 'version', label: t('route_error.version'), value: diagnostics.version || unavailable },
    { key: 'time', label: t('route_error.time'), value: diagnostics.occurredAt },
    ...(diagnostics.status !== undefined ? [{ key: 'status', label: t('route_error.http_status'), value: diagnostics.status }] : []),
  ];

  // A new document clears rejected lazy imports; client-side navigation cannot reliably retry them.
  return (
    <main className={styles['error-page']} aria-labelledby="route-error-title">
      <div className={styles['error-content']}>
        <header className={styles['brand-header']}>
          <BrandArtwork shape="wordmark" height={22} label="Oh My CPA" />
          <StatusLabel tone="danger">{t('route_error.status')}</StatusLabel>
        </header>
        <Card className={styles['recovery-panel']}>
          <h1 id="route-error-title" ref={headingRef} tabIndex={-1} className={`terminal-title ${styles['error-title']}`}>
            {t('route_error.title')}
          </h1>
          <p className={styles['error-description']}>{t('route_error.description')}</p>
          <div className={styles['recovery-actions']}>
            <Button href={dashboardPath}>
              {t('route_error.home')}
            </Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
              {t('route_error.reload')}
            </Button>
          </div>
          <section className={styles['diagnostics']} aria-label={t('route_error.diagnostics')}>
            <PanelTitle extra={<CopyButton text={formatRouteErrorReport(diagnostics)} label={t('route_error.copy')} showLabel />}>
              {t('route_error.diagnostics')}
            </PanelTitle>
            <FactList facts={facts} emphasis="quiet" />
            <p className={styles['message-label']}>{t('route_error.message')}</p>
            <pre className={styles['diagnostic-code']} data-testid="route-error-message">
              {diagnostics.message || t('route_error.no_message')}
            </pre>
            <details className={styles['stack-details']}>
              <summary>{t('route_error.stack')}</summary>
              <pre className={styles['diagnostic-code']} data-testid="route-error-stack">
                {diagnostics.stack || t('route_error.no_stack')}
              </pre>
            </details>
          </section>
        </Card>
        <p className={styles['recovery-hint']}>{t('route_error.hint')}</p>
      </div>
    </main>
  );
};
