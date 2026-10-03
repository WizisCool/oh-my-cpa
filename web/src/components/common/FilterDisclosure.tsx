import React from 'react';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useT } from '../../i18n';

/** Search remains direct; additional filters keep their current selection in the summary. */
export function FilterDisclosure({ children, activeLabel }: { children: React.ReactNode; activeLabel?: React.ReactNode }) {
  const isPhone = useIsPhoneViewport();
  const t = useT();
  if (!isPhone) return <>{children}</>;
  return (
    <details className="phone-filter-disclosure">
      <summary>{t('mobile.filters')}{activeLabel && <span className="phone-filter-current">{activeLabel}</span>}</summary>
      <div className="phone-filter-content">{children}</div>
    </details>
  );
}
