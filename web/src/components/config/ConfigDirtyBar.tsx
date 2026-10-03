import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Popconfirm, Space } from 'antd';
import { CheckOutlined, CloseOutlined } from '../icons';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';

export interface ConfigDirtyBarProps {
  isDirty: boolean;
  isSaving: boolean;
  yamlError?: boolean;
  payloadIssuesCount?: number;
  showErrorFeedback?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** True when the deployment refuses configuration writes, as the demo does. */
  disabled?: boolean;
  container?: HTMLElement | null;
  viewportBottom?: number;
  onHeightChange?: (height: number) => void;
}

export const ConfigDirtyBar: React.FC<ConfigDirtyBarProps> = ({
  isDirty,
  isSaving,
  yamlError = false,
  payloadIssuesCount = 0,
  showErrorFeedback = false,
  onSave,
  onDiscard,
  disabled = false,
  container,
  viewportBottom = 0,
  onHeightChange,
}) => {
  const t = useT();
  const barRef = React.useRef<HTMLDivElement>(null);
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
  const saveRef = React.useRef<HTMLButtonElement>(null);
  const closeConfirmation = () => {
    setIsConfirmOpen(false);
    saveRef.current?.focus({ preventScroll: true });
  };
  useOverlayHistory({ isOpen: isConfirmOpen && isDirty, onClose: closeConfirmation });
  React.useEffect(() => {
    if (!isDirty) setIsConfirmOpen(false);
  }, [isDirty]);
  React.useLayoutEffect(() => {
    const bar = barRef.current;
    if (!isDirty || !bar) {
      onHeightChange?.(0);
      return;
    }
    const measureBar = () => onHeightChange?.(bar.getBoundingClientRect().height);
    const observer = new ResizeObserver(measureBar);
    observer.observe(bar);
    measureBar();
    return () => observer.disconnect();
  }, [isDirty, container, onHeightChange]);

  if (!isDirty) return null;

  const hasErrors = yamlError || payloadIssuesCount > 0;

  const errorReason = yamlError
    ? t('cfg.dirty_bar_yaml_error')
    : showErrorFeedback && payloadIssuesCount > 0
    ? t('cfg.dirty_bar_payload_issues', { n: payloadIssuesCount })
    : undefined;

  const content = (
    <div
      className={`config-dirty-bar-portal${container ? ' is-contained' : ''}`}
      style={!container && viewportBottom > 0 ? { bottom: viewportBottom + 12 } : undefined}
      role="region"
      aria-label={t('cfg.dirty_bar_unsaved')}
      aria-live="polite"
    >
      <div ref={barRef} className="config-dirty-bar">
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
              disabled={isSaving || disabled}
              title={disabled ? t('demo.blocked') : undefined}
              onClick={onSave}
              className="config-dirty-btn-save"
            >
              {t('cfg.dirty_bar_save')}
            </Button>
          ) : (
            <Popconfirm
              title={t('cfg.source_save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              open={isConfirmOpen}
              onOpenChange={setIsConfirmOpen}
              onCancel={closeConfirmation}
              onConfirm={() => {
                // Close before saving so a conflict dialog becomes the top history overlay.
                setIsConfirmOpen(false);
                onSave();
              }}
              okButtonProps={{ 'aria-label': t('common.confirm') }}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              disabled={isSaving || disabled}
              placement="topRight"
            >
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={isSaving}
                disabled={isSaving || disabled}
                title={disabled ? t('demo.blocked') : undefined}
                ref={saveRef}
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
  return createPortal(content, container ?? document.body);
};

export default ConfigDirtyBar;
