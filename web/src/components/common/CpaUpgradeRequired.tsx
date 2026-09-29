import React from 'react';
import { Result, Typography } from 'antd';
import { WarningOutlined } from '../icons';
import { useT } from '../../i18n';
import { CodeFrame } from './CodeFrame';

/** The image the bundled Compose file pins, shown as the upgrade target. */
const CPA_UPGRADE_IMAGE = 'eceasy/cli-proxy-api:v8.0.2';

/**
 * Stands in for every page while the gateway is older than CPA v8.
 *
 * The console is built on the v8 Management API alone, so a v7 gateway cannot serve
 * any page: rendering them would scatter one fact - the gateway must be upgraded -
 * across a screen of "unsupported operation" errors. The shell stays, so the
 * operator can still sign out and see the connection state while upgrading; the
 * health poll lifts this as soon as the gateway answers as v8.
 */
export const CpaUpgradeRequired: React.FC = () => {
  const t = useT();
  const command = `CPA_IMAGE=${CPA_UPGRADE_IMAGE} docker compose -f deploy/compose.full.yml up -d cpa`;
  return (
    <div className="cpa-blocked" data-cpa-upgrade-required>
      <Result
        status="warning"
        icon={<WarningOutlined />}
        title={t('shell.cpa_v8_required_title')}
        subTitle={t('shell.cpa_v8_required_desc')}
        extra={(
          <div className="cpa-blocked-steps">
            <Typography.Paragraph>{t('shell.cpa_v8_required_compose')}</Typography.Paragraph>
            <CodeFrame code={command} label="shell" />
            <Typography.Paragraph type="secondary">{t('shell.cpa_v8_required_config')}</Typography.Paragraph>
          </div>
        )}
      />
    </div>
  );
};
