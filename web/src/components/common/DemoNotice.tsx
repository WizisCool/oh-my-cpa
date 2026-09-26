import React from 'react';
import { App as AntdApp } from 'antd';
import { setDemoNoticeHandler, setDemoRefusalLabel } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';

/**
 * Reports what a demo deployment does to the writes the console performs.
 *
 * A write that succeeded was kept in memory only, and that is the one thing no caller can
 * know: it is registered on the API client rather than passed down, because the call sites
 * are spread across every page and a form added later must not be able to forget it.
 *
 * A refused write is different, and is deliberately not reported here as well. Every caller
 * already reports the failure it caught, so a notice of our own put two messages on screen
 * for one refusal: this one in the reader's language, and the caller's copy of the server's
 * English prose. The console's sentence for a refusal is handed to the API layer instead
 * (`setDemoRefusalLabel`), so whichever caller reports it reports the same, single sentence.
 */
export const DemoNotice: React.FC = () => {
  const { message } = AntdApp.useApp();
  const t = useT();

  React.useEffect(() => {
    if (!isDemoMode()) return undefined;
    // Throttled, because one refusal can arrive from several calls at once: a page whose
    // control fires a fan-out of refused writes must say so once, not once per call.
    const NOTICE_INTERVAL_MS = 8000;
    let lastShownAt = 0;
    setDemoNoticeHandler(() => {
      const now = Date.now();
      if (now - lastShownAt < NOTICE_INTERVAL_MS) return;
      lastShownAt = now;
      void message.warning({ content: t('demo.notice'), key: 'omc-demo-notice', duration: 5 });
    });
    setDemoRefusalLabel(t('demo.blocked'));
    return () => {
      setDemoNoticeHandler(undefined);
      setDemoRefusalLabel(undefined);
    };
  }, [message, t]);

  return null;
};
