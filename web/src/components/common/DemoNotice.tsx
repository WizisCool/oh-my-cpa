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
    // One notice on screen at a time, always the most recent: the two kinds share a
    // message key, so a refusal that happened a moment ago is replaced by the result
    // of the action the operator just took rather than stacking beside it.
    //
    // They keep separate windows, though. A page that fires several refused calls at
    // once - which is what a button that would have started a sign-in does - must not
    // silence the answer to the single write the operator performs next, and one
    // shared window did exactly that.
    const NOTICE_INTERVAL_MS = 8000;
    const lastShownAt = { notice: 0, blocked: 0 };
    const show = (kind: 'notice' | 'blocked', text: string) => {
      const now = Date.now();
      if (now - lastShownAt[kind] < NOTICE_INTERVAL_MS) return;
      lastShownAt[kind] = now;
      void message.warning({ content: text, key: 'omc-demo-notice', duration: 5 });
    };
    setDemoNoticeHandler(() => show('notice', t('demo.notice')));
    setDemoBlockedHandler(() => show('blocked', t('demo.blocked')));
    return () => {
      setDemoNoticeHandler(undefined);
      setDemoBlockedHandler(undefined);
    };
  }, [message, t]);

  return null;
};
