import React from 'react';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useT } from '../../i18n';

/**
 * Search remains direct; additional filters keep their current selection in the summary. Each active
 * filter is its own quiet chip, so two selections read as two things rather than one joined phrase.
 */
export function FilterDisclosure({ children, activeLabel }: {
  children: React.ReactNode;
  activeLabel?: React.ReactNode | readonly (string | false | null | undefined)[];
}) {
  const isPhone = useIsPhoneViewport();
  const t = useT();
  if (!isPhone) return <>{children}</>;
  const labels = Array.isArray(activeLabel)
    ? activeLabel.filter((label): label is string => typeof label === 'string' && label !== '')
    : activeLabel ? [activeLabel as React.ReactNode] : [];
  return (
    <details className="phone-filter-disclosure">
      <summary>
        {t('mobile.filters')}
        {labels.map((label, index) => <span key={index} className="phone-filter-current">{label}</span>)}
      </summary>
      <div className="phone-filter-content">{children}</div>
    </details>
  );
}
