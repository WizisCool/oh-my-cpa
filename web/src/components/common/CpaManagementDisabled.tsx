import React from 'react';
import { WarningOutlined } from '../icons';
import { useT } from '../../i18n';
import { CodeFrame } from './CodeFrame';

const CPA_MANAGEMENT_SNIPPET = 'management:\n  secret-key: "<OMCPA_CPA_MANAGEMENT_KEY>"';

export const CpaManagementDisabled: React.FC = () => {
  const t = useT();
  return (
    <div className="cpa-blocked" data-cpa-management-disabled>
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-[var(--warn)]">
          <WarningOutlined style={{ fontSize: 24 }} />
        </span>
        <h2 className="m-0 text-lg font-semibold text-foreground">{t('shell.cpa_management_disabled_title')}</h2>
        <p className="m-0 max-w-xl text-sm text-muted-foreground">{t('shell.cpa_management_disabled_desc')}</p>
        <div className="cpa-blocked-steps mt-3 w-full">
          <p className="m-0 text-sm text-foreground">{t('shell.cpa_management_disabled_config')}</p>
          <CodeFrame code={CPA_MANAGEMENT_SNIPPET} label="yaml" lang="yaml" />
          <p className="m-0 text-xs text-muted-foreground">{t('shell.cpa_management_disabled_lift')}</p>
        </div>
      </div>
    </div>
  );
};
