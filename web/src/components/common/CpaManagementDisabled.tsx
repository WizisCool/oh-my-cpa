import React from 'react';
import { Result, Typography } from 'antd';
import { WarningOutlined } from '../icons';
import { useT } from '../../i18n';
import { CodeFrame } from './CodeFrame';

const CPA_MANAGEMENT_SNIPPET = 'remote-management:\n  secret-key: "<OMCPA_CPA_MANAGEMENT_KEY>"';

/**
 * Stands in for every page while the gateway serves no Management API at all.
 *
 * CPA answers 404 on every management path until a management secret is set, so its
 * version cannot be observed and upgrade guidance would send the operator the wrong
 * way. The health poll lifts this as soon as either management tree answers.
 */
export const CpaManagementDisabled: React.FC = () => {
  const t = useT();
  return (
    <div className="cpa-blocked" data-cpa-management-disabled>
      <Result
        status="warning"
        icon={<WarningOutlined />}
        title={t('shell.cpa_management_disabled_title')}
        subTitle={t('shell.cpa_management_disabled_desc')}
        extra={(
          <div className="cpa-blocked-steps">
            <Typography.Paragraph>{t('shell.cpa_management_disabled_config')}</Typography.Paragraph>
            <CodeFrame code={CPA_MANAGEMENT_SNIPPET} label="yaml" />
            <Typography.Paragraph type="secondary">{t('shell.cpa_management_disabled_lift')}</Typography.Paragraph>
          </div>
        )}
      />
    </div>
  );
};
