import React from 'react';
import { WarningOutlined } from '../icons';
import { useT } from '../../i18n';
import { CodeFrame } from './CodeFrame';

const CPA_UPGRADE_IMAGE = 'eceasy/cli-proxy-api:v8.0.2';

export const CpaUpgradeRequired: React.FC = () => {
  const t = useT();
  const command = `CPA_IMAGE=${CPA_UPGRADE_IMAGE} docker compose -f deploy/compose.full.yml up -d cpa`;
  return (
    <div className="cpa-blocked" data-cpa-upgrade-required>
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-[var(--warn)]">
          <WarningOutlined style={{ fontSize: 24 }} />
        </span>
        <h2 className="m-0 text-lg font-semibold text-foreground">{t('shell.cpa_v8_required_title')}</h2>
        <p className="m-0 max-w-xl text-sm text-muted-foreground">{t('shell.cpa_v8_required_desc')}</p>
        <div className="cpa-blocked-steps mt-3 w-full">
          <p className="m-0 text-sm text-foreground">{t('shell.cpa_v8_required_compose')}</p>
          <CodeFrame code={command} label="shell" lang="bash" />
          <p className="m-0 text-xs text-muted-foreground">{t('shell.cpa_v8_required_config')}</p>
        </div>
      </div>
    </div>
  );
};
