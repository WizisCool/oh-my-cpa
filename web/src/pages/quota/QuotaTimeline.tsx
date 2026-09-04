import React, { useMemo } from 'react';
import { ClockCircleOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import styles from './QuotaPage.module.css';

interface QuotaTimelineProps {
  items: QuotaItem[];
}

interface TimelineEntry {
  authIndex: string;
  name: string;
  provider: string;
  resetAtMS: number;
  label: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const QuotaTimeline: React.FC<QuotaTimelineProps> = ({ items }) => {
  const t = useT();
  const nowMS = Date.now();

  // Find all future resets across items and windows
  const timelineEntries = useMemo(() => {
    const list: TimelineEntry[] = [];

    items.forEach((item) => {
      // Check cooldown recover
      if (item.active_cooldown?.is_active && item.active_cooldown.recover_at_ms) {
        if (item.active_cooldown.recover_at_ms > nowMS) {
          list.push({
            authIndex: item.auth_index,
            name: item.name,
            provider: item.provider,
            resetAtMS: item.active_cooldown.recover_at_ms,
            label: `${t('quota.status_cooldown')}: ${item.name}`,
          });
        }
      }

      // Check windows
      item.windows.forEach((w) => {
        if (w.reset_at_ms && w.reset_at_ms > nowMS) {
          list.push({
            authIndex: item.auth_index,
            name: item.name,
            provider: item.provider,
            resetAtMS: w.reset_at_ms,
            label: `${item.name} (${w.label})`,
          });
        }
      });
    });

    // Deduplicate by name + resetAtMS (within 1 minute) and sort ascending
    list.sort((a, b) => a.resetAtMS - b.resetAtMS);
    return list.slice(0, 10); // show top 10 soonest
  }, [items, nowMS, t]);

  if (timelineEntries.length === 0) {
    return null;
  }

  return (
    <div className={styles.timelineContainer}>
      <div className={styles.timelineHeader}>
        <div className={styles.timelineTitle}>
          <ClockCircleOutlined />
          <span>{t('quota.timeline_title')}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t('quota.timeline_scope_7d')}</span>
      </div>

      {/* Axis markers */}
      <div className={styles.timelineAxis}>
        <span>{t('quota.timeline_now')}</span>
        <span>+1h</span>
        <span>+5h</span>
        <span>+24h</span>
        <span>+7d</span>
      </div>

      {/* Lanes */}
      <div className={styles.timelineLanes}>
        {timelineEntries.map((entry, idx) => {
          const diff = Math.max(0, entry.resetAtMS - nowMS);
          const percent = Math.min(100, Math.max(2, (diff / SEVEN_DAYS_MS) * 100));
          const dateStr = new Date(entry.resetAtMS).toLocaleString();

          return (
            <div key={`${entry.authIndex}_${idx}`} className={styles.timelineLane}>
              <span className={styles.timelineLaneLabel} title={entry.label}>
                {entry.name}
              </span>
              <div className={styles.timelineTrack} title={`${entry.label}: ${dateStr}`}>
                <div
                  className={styles.timelineMarker}
                  style={{
                    left: 0,
                    width: `${percent}%`,
                  }}
                />
              </div>
              <span style={{ fontSize: 10, color: 'var(--meta)', width: 60, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                {Math.ceil(diff / 60000)}m
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
