import React from 'react';
import { App as AntdApp } from 'antd';
import { setDemoBlockedHandler, setDemoNoticeHandler } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';

/**
 * Reports what a demo deployment does to the writes the console performs.
 *
 * Two things need saying, and they are different: a write that succeeded was kept
 * in memory only, and a write the server refuses is one the demonstration does not
 * perform at all. Saying either one right after the click is the only moment the
 * operator is looking.
 *
 * The handlers are registered on the API client rather than passed down, because
 * the call sites are spread across every page and a form added later must not be
 * able to forget this.
 */
export const DemoNotice: React.FC = () => {
  const { message } = AntdApp.useApp();
  const t = useT();

  React.useEffect(() => {
    if (!isDemoMode()) return undefined;
    // One notice per burst: a page that saves three things at once should not stack
    // three identical messages on top of the content the operator is reading.
    let lastNoticeAt = 0;
    let lastBlockedAt = 0;
    const NOTICE_INTERVAL_MS = 8000;
    const showOnce = (now: number, last: number, text: string) => {
      if (now - last < NOTICE_INTERVAL_MS) return last;
      void message.warning({ content: text, key: 'omc-demo-notice', duration: 4 });
      return now;
    };
    setDemoNoticeHandler(() => {
      lastNoticeAt = showOnce(Date.now(), lastNoticeAt, t('demo.notice'));
    });
    setDemoBlockedHandler(() => {
      lastBlockedAt = showOnce(Date.now(), lastBlockedAt, t('demo.blocked'));
    });
    return () => {
      setDemoNoticeHandler(undefined);
      setDemoBlockedHandler(undefined);
    };
  }, [message, t]);

  return null;
};
