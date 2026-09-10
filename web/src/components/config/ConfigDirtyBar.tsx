import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Popconfirm, Space } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';

export interface ConfigDirtyBarProps {
  isDirty: boolean;
  isSaving: boolean;
  yamlError?: boolean;
  payloadIssuesCount?: number;
  showErrorFeedback?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

export const ConfigDirtyBar: React.FC<ConfigDirtyBarProps> = ({
  isDirty,
  isSaving,
  yamlError = false,
  payloadIssuesCount = 0,
  showErrorFeedback = false,
  onSave,
  onDiscard,
}) => {
  const t = useT();

  if (!isDirty) return null;

  const hasErrors = yamlError || payloadIssuesCount > 0;

  const errorReason = yamlError
    ? t('cfg.dirty_bar_yaml_error')
    : showErrorFeedback && payloadIssuesCount > 0
    ? t('cfg.dirty_bar_payload_issues', { n: payloadIssuesCount })
    : undefined;

  const content = (
    <div
      className="config-dirty-bar-portal"
      role="region"
      aria-label={t('cfg.dirty_bar_unsaved')}
      aria-live="polite"
    >
      <div className="config-dirty-bar">
        <div className="config-dirty-bar-left">
          <span className="config-dirty-dot" />
          <span className="config-dirty-text">{t('cfg.dirty_bar_unsaved')}</span>
          {errorReason && (
            <span className="config-dirty-error">
              ({errorReason})
            </span>
          )}
        </div>

        <Space size={10} className="config-dirty-bar-actions">
          {/* Discard needs no confirmation, invoking the rollback directly. */}
          <Button
            size="small"
            icon={<CloseOutlined />}
            disabled={isSaving}
            onClick={onDiscard}
            className="config-dirty-btn-discard"
          >
            {t('cfg.dirty_bar_discard')}
          </Button>

          {/* Save with invalid input highlights and expands the errors instead;
              a valid form goes through confirmation. */}
          {hasErrors ? (
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={isSaving}
              disabled={isSaving}
              onClick={onSave}
              className="config-dirty-btn-save"
            >
              {t('cfg.dirty_bar_save')}
            </Button>
          ) : (
            <Popconfirm
              title={t('cfg.source_save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              onConfirm={onSave}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              disabled={isSaving}
              placement="topRight"
            >
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={isSaving}
                disabled={isSaving}
                className="config-dirty-btn-save"
              >
                {t('cfg.dirty_bar_save')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
};

export default ConfigDirtyBar;
