import React from 'react';
import { Input, InputNumber, Segmented } from 'antd';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { Panel } from '../../components/common/Panel';
import { SectionHeading } from '../../components/common/SectionHeading';
import { SettingRow } from '../../components/common/SettingRow';
import { Switch } from '../../components/common/Switch';
import { Fold } from '../../components/common/Fold';
import { DownOutlined, RightOutlined } from '../../components/icons';
import type { RoutingSettings, RoutingStrategy } from '../../types/routing';
import styles from './RoutingPage.module.css';

const STRATEGIES: { value: RoutingStrategy; labelKey: MessageKey; descKey: MessageKey }[] = [
  { value: 'round-robin', labelKey: 'orch.strategy_rr', descKey: 'orch.strategy_rr_desc' },
  { value: 'weighted-round-robin', labelKey: 'orch.strategy_wrr', descKey: 'orch.strategy_wrr_desc' },
  { value: 'fill-first', labelKey: 'orch.strategy_ff', descKey: 'orch.strategy_ff_desc' },
];

/** How three requests land on two peers under a strategy, drawn as three dots each. */
const StrategyGlyph: React.FC<{ strategy: RoutingStrategy }> = ({ strategy }) => {
  const lanes = strategy === 'fill-first' ? [3, 0] : strategy === 'weighted-round-robin' ? [2, 1] : [2, 2];
  return (
    <span className={styles['strategy-glyph']} aria-hidden="true">
      {lanes.map((count, lane) => (
        <span key={lane} className={styles['strategy-lane']}>
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={index < count ? styles['strategy-dot'] : styles['strategy-dot-idle']} />
          ))}
        </span>
      ))}
    </span>
  );
};

export interface PolicyStripProps {
  settings: RoutingSettings;
  onChange: (settings: RoutingSettings) => void;
  disabled?: boolean;
}

/**
 * The gateway-wide half of the arrangement, beside the route it governs: how a tier shares its
 * requests, whether a session stays on one credential, and how far a failing request travels. The
 * strategy is the one choice every tier reads, so it leads; failover is folded until it is wanted.
 */
export const PolicyStrip: React.FC<PolicyStripProps> = ({ settings, onChange, disabled }) => {
  const t = useT();
  const [isFailoverOpen, setIsFailoverOpen] = React.useState(false);
  const set = <K extends keyof RoutingSettings>(key: K, value: RoutingSettings[K]) => onChange({ ...settings, [key]: value });
  const current = STRATEGIES.find((strategy) => strategy.value === settings.strategy) ?? STRATEGIES[0];
  const whole = (value: number | null, minimum: number) => Math.max(minimum, Math.trunc(value ?? minimum));

  return (
    <Panel className={styles['policy']}>
      <SectionHeading level="group" as="h2" title={t('orch.policy')} description={t('orch.policy_desc')} />
      <div className={styles['policy-strategy']}>
        <span className={styles['policy-label']}>{t('orch.strategy')}</span>
        <Segmented<RoutingStrategy>
          vertical
          block
          className={styles['strategy-control']}
          value={settings.strategy}
          disabled={disabled}
          onChange={(value) => set('strategy', value)}
          options={STRATEGIES.map((strategy) => ({
            value: strategy.value,
            label: (
              <span className={styles['strategy-option']}>
                <StrategyGlyph strategy={strategy.value} />
                {t(strategy.labelKey)}
              </span>
            ),
          }))}
        />
        <span className={styles['policy-hint']}>{t(current.descKey)}</span>
      </div>
      <SettingRow
        label={t('cfg.f_affinity')}
        description={t('cfg.f_affinity_desc')}
        control={(
          <span className={styles['policy-inline']}>
            {settings.session_affinity && (
              <Input
                size="small"
                className={styles['ttl-input']}
                aria-label={t('cfg.f_affinity_ttl')}
                placeholder="1h"
                value={settings.session_affinity_ttl}
                disabled={disabled}
                onChange={(event) => set('session_affinity_ttl', event.target.value)}
              />
            )}
            <Switch
              checked={settings.session_affinity}
              disabled={disabled}
              aria-label={t('cfg.f_affinity')}
              onChange={(checked) => set('session_affinity', checked)}
            />
          </span>
        )}
      />
      <button
        type="button"
        className={styles['failover-toggle']}
        aria-expanded={isFailoverOpen}
        aria-controls="routing-failover"
        onClick={() => setIsFailoverOpen((isOpen) => !isOpen)}
      >
        {isFailoverOpen ? <DownOutlined /> : <RightOutlined />}
        {t('orch.failover')}
        <span className={styles['policy-hint']}>
          {t('orch.failover_summary', { rounds: settings.request_retry, credentials: settings.max_retry_credentials || '∞' })}
        </span>
      </button>
      <Fold isOpen={isFailoverOpen} id="routing-failover">
        <div className={styles['failover']}>
          <SettingRow
            label={t('cfg.request_retry')}
            description={t('cfg.request_retry_desc')}
            control={<InputNumber size="small" min={0} precision={0} aria-label={t('cfg.request_retry')} value={settings.request_retry} disabled={disabled} onChange={(value) => set('request_retry', whole(value, 0))} />}
          />
          <SettingRow
            label={t('cfg.max_retry_credentials')}
            description={t('cfg.max_retry_credentials_desc')}
            control={<InputNumber size="small" min={0} precision={0} aria-label={t('cfg.max_retry_credentials')} value={settings.max_retry_credentials} disabled={disabled} onChange={(value) => set('max_retry_credentials', whole(value, 0))} />}
          />
          <SettingRow
            label={t('cfg.max_retry_interval')}
            description={t('cfg.max_retry_interval_desc')}
            control={<InputNumber size="small" min={0} precision={0} aria-label={t('cfg.max_retry_interval')} value={settings.max_retry_interval} disabled={disabled} onChange={(value) => set('max_retry_interval', whole(value, 0))} />}
          />
          <SettingRow
            label={t('cfg.f_transient_cooldown')}
            description={t('cfg.f_transient_cooldown_desc')}
            control={<InputNumber size="small" min={-1} precision={0} aria-label={t('cfg.f_transient_cooldown')} value={settings.transient_error_cooldown_seconds} disabled={disabled} onChange={(value) => set('transient_error_cooldown_seconds', whole(value, -1))} />}
          />
          <SettingRow
            label={t('cfg.f_disable_cooling')}
            description={t('cfg.f_disable_cooling_desc')}
            control={<Switch checked={settings.disable_cooling} disabled={disabled} aria-label={t('cfg.f_disable_cooling')} onChange={(checked) => set('disable_cooling', checked)} />}
          />
        </div>
      </Fold>
    </Panel>
  );
};
