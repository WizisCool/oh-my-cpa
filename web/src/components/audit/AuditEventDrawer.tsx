import React from 'react';
import { Button, Drawer } from 'antd';
import dayjs from 'dayjs';
import { DownOutlined, FilterOutlined, UpOutlined } from '../icons';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import {
  categoryOf,
  formatDetailValue,
  parseAuditSource,
  resultTone,
  type AuditEvent,
} from '../../types/audit';
import { FactList, type Fact } from '../common/FactList';
import { StatusLabel } from '../common/StatusLabel';
import { CopyButton } from '../common/CopyButton';
import { auditActionLabel, auditResultLabel } from './auditText';
import styles from './Audit.module.css';

export interface AuditEventDrawerProps {
  /** The entry on display; undefined closes the drawer. */
  event: AuditEvent | undefined;
  /** Neighbours in the loaded trail, newest first; undefined at either end. */
  newer?: AuditEvent;
  older?: AuditEvent;
  onNavigate: (event: AuditEvent) => void;
  onClose: () => void;
  /** Narrows the trail to one identifier from the entry, and closes the drawer on it. */
  onSearch: (needle: string) => void;
}

/**
 * One audit entry in full, in the Drawer every other console record opens in.
 *
 * The row is a reading (what, on what, how it ended); everything a reader needs to act on
 * an entry - the action code, the request that carried it, where it came from and the
 * detail it recorded - lives here, with the two questions an entry raises one click away:
 * what else happened to this target, and what else did this request do.
 */
export const AuditEventDrawer: React.FC<AuditEventDrawerProps> = ({ event, newer, older, onNavigate, onClose, onSearch }) => {
  const t = useT();
  const isOpen = event !== undefined;
  useOverlayHistory({ isOpen, onClose });

  // `[` and `]` step through the loaded trail, as they do in the request drawer.
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (keyEvent.key === '[' && newer) onNavigate(newer);
      if (keyEvent.key === ']' && older) onNavigate(older);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, newer, older, onNavigate]);

  const facts: Fact[] = [];
  const details: Fact[] = [];
  if (event) {
    const category = categoryOf(event.action);
    const source = parseAuditSource(event.source_summary);
    facts.push(
      { key: 'time', label: t('audit.field_time'), value: <span className={styles['audit-mono']}>{dayjs(event.occurred_at_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}</span> },
      { key: 'action', label: t('audit.field_action'), value: <span className={styles['audit-mono']}>{event.action}</span> },
    );
    if (category) facts.push({ key: 'category', label: t('audit.col_category'), value: t(`audit.cat.${category}`) });
    facts.push({
      key: 'target',
      label: t('audit.field_target'),
      value: <span className={styles['audit-mono']}>{[event.target_type, event.target_id].filter(Boolean).join(' / ') || '—'}</span>,
    });
    if (event.request_id) {
      facts.push({
        key: 'request',
        label: t('audit.field_request'),
        value: (
          <span className={styles['audit-copyable']}>
            <span className={styles['audit-mono']}>{event.request_id}</span>
            <CopyButton text={event.request_id} />
          </span>
        ),
      });
    }
    if (source.ip) facts.push({ key: 'ip', label: t('audit.field_ip'), value: <span className={styles['audit-mono']}>{source.ip}</span> });
    if (source.userAgent) facts.push({ key: 'agent', label: t('audit.field_agent'), value: source.userAgent });
    for (const [key, value] of Object.entries(event.details ?? {})) {
      details.push({ key, label: <span className={styles['audit-mono']}>{key}</span>, value: <span className={styles['audit-mono']}>{formatDetailValue(value)}</span> });
    }
  }

  const targetId = event?.target_id.trim() ?? '';
  const requestId = event?.request_id ?? '';

  const title = (
    <div className={styles['drawer-title']}>
      <span className={styles['drawer-title-text']}>{event ? auditActionLabel(event.action, t) : t('common.details')}</span>
      <span className={styles['drawer-nav']}>
        <Button
          size="small"
          type="text"
          icon={<UpOutlined />}
          disabled={!newer}
          onClick={() => newer && onNavigate(newer)}
          title={`${t('events.prev_item')} ([)`}
          aria-label={t('events.prev_item')}
        />
        <Button
          size="small"
          type="text"
          icon={<DownOutlined />}
          disabled={!older}
          onClick={() => older && onNavigate(older)}
          title={`${t('events.next_item')} (])`}
          aria-label={t('events.next_item')}
        />
      </span>
    </div>
  );

  return (
    <Drawer
      title={title}
      size={560}
      open={isOpen}
      onClose={onClose}
      closable={{ 'aria-label': t('common.close') }}
      footer={event && (targetId || requestId) ? (
        <div className={styles['drawer-footer']}>
          {targetId && (
            <Button icon={<FilterOutlined />} onClick={() => onSearch(targetId)}>
              {t('audit.only_target')}
            </Button>
          )}
          {requestId && (
            <Button icon={<FilterOutlined />} onClick={() => onSearch(requestId)}>
              {t('audit.only_request')}
            </Button>
          )}
        </div>
      ) : undefined}
    >
      {event && (
        <div className={styles['drawer-body']} data-testid="audit-detail">
          <div className={styles['drawer-verdict']}>
            <StatusLabel tone={resultTone(event.result)}>{auditResultLabel(event.result, t)}</StatusLabel>
          </div>
          <section className={styles['drawer-section']}>
            <FactList facts={facts} emphasis="quiet" />
          </section>
          {details.length > 0 && (
            <section className={styles['drawer-section']} aria-label={t('audit.field_details')}>
              <h3 className={styles['drawer-section-title']}>{t('audit.field_details')}</h3>
              <FactList facts={details} emphasis="quiet" />
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
};
