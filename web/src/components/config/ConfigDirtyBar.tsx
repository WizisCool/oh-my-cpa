import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Space } from 'antd';
import { CheckOutlined, CloseOutlined } from '../icons';
import { useT } from '../../i18n';
import { ConfirmAction } from '../common/ConfirmAction';
import './config.css';

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
  /** Explains a write restriction outside demo mode. */
  disabledReason?: string;
  /** A completed write is awaiting readback, so even discard must wait. */
  isDiscardDisabled?: boolean;
  container?: HTMLElement | null;
  viewportBottom?: number;
  onHeightChange?: (height: number) => void;
  /** Replaces the default "unsaved changes" label, e.g. with a count. */
  label?: React.ReactNode;
  /** The confirmation's own question; the default speaks of the configuration file. */
  confirmTitle?: React.ReactNode;
  confirmDescription?: React.ReactNode;
  /** A control beside the label, such as a review of what will be written. */
  extra?: React.ReactNode;
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
  disabledReason,
  isDiscardDisabled = false,
  container,
  viewportBottom = 0,
  onHeightChange,
  label,
  confirmTitle,
  confirmDescription,
  extra,
}) => {
  const t = useT();
  const barRef = React.useRef<HTMLDivElement>(null);
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
  const saveRef = React.useRef<HTMLButtonElement>(null);
  const closeConfirmation = () => {
    setIsConfirmOpen(false);
    saveRef.current?.focus({ preventScroll: true });
  };
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
          <span className="config-dirty-text">{label ?? t('cfg.dirty_bar_unsaved')}</span>
          {errorReason && (
            <span className="config-dirty-error">
              ({errorReason})
            </span>
          )}
          {extra}
        </div>

        <Space size={10} className="config-dirty-bar-actions">
          {/* Discard needs no confirmation, invoking the rollback directly. */}
          <Button
            size="small"
            icon={<CloseOutlined />}
            disabled={isSaving || isDiscardDisabled}
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
              title={disabled ? disabledReason ?? t('demo.blocked') : undefined}
              onClick={onSave}
              className="config-dirty-btn-save"
            >
              {t('cfg.dirty_bar_save')}
            </Button>
          ) : (
            <ConfirmAction
              title={confirmTitle ?? t('cfg.source_save_confirm')}
              description={confirmDescription ?? t('cfg.source_save_confirm_desc')}
              open={isConfirmOpen}
              onOpenChange={setIsConfirmOpen}
              onCancel={closeConfirmation}
              onConfirm={() => {
                // Close before saving so a conflict dialog does not layer under the confirmation.
                setIsConfirmOpen(false);
                onSave();
              }}
              confirmButtonProps={{ 'aria-label': t('common.confirm') }}
              disabled={isSaving || disabled}
              placement="topRight"
            >
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={isSaving}
                disabled={isSaving || disabled}
                title={disabled ? disabledReason ?? t('demo.blocked') : undefined}
                ref={saveRef}
                className="config-dirty-btn-save"
              >
                {t('cfg.dirty_bar_save')}
              </Button>
            </ConfirmAction>
          )}
        </Space>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, container ?? document.body);
};

export default ConfigDirtyBar;
