import React from 'react';
import { Space, Tabs } from 'antd';
import clsx from 'clsx';
// The provider tabs' stylesheet, shared rather than copied, so the console's two tab rows
// with counts cannot drift apart.
import styles from './ProviderFilterTabs.module.css';

export interface CountTab<K extends string> {
  key: K;
  label: React.ReactNode;
  /** The count pill; undefined while it is not known yet, drawn as a dash rather than a zero. */
  count?: number;
  /** A leading mark, such as a status pip. */
  icon?: React.ReactNode;
}

export interface CountTabsProps<K extends string> {
  tabs: readonly CountTab<K>[];
  active: K;
  onChange: (key: K) => void;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

/**
 * A filter drawn as a tab row whose every option carries its count: the OAuth provider tabs'
 * look, for a filter that is not a provider.
 */
export function CountTabs<K extends string>({ tabs, active, onChange, ariaLabel, testId, className }: CountTabsProps<K>) {
  return (
    <div className={clsx(styles['tabs-wrap'], className)} data-testid={testId}>
      <Tabs
        activeKey={active}
        onChange={(key) => onChange(key as K)}
        size="small"
        aria-label={ariaLabel}
        items={tabs.map((tab) => ({
          key: tab.key,
          label: (
            <Space size={6} align="center" data-testid={testId ? `${testId}-${tab.key}` : undefined}>
              {tab.icon}
              <span>{tab.label}</span>
              <span className={clsx(styles['tab-count'], tab.key === active && styles['tab-count-active'])}>
                {tab.count === undefined ? '—' : tab.count.toLocaleString()}
              </span>
            </Space>
          ),
        }))}
      />
    </div>
  );
}
