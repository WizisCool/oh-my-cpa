import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Input, Tag, Empty, theme } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { LOBE_ICON_CATALOG, type LobeIconCatalogEntry } from '../types/lobeIconCatalog';
import { LobeIcon } from './LobeIcon';
import { useT } from '../i18n';

/**
 * ANTD_CONTAINER_ZINDEX_STEP is the step antd 6 reserves per container level
 * (Drawer, Modal, Popover) above `zIndexPopupBase`; see
 * `antd/es/_util/hooks/useZIndex.js`, where CONTAINER_OFFSET is 100.
 *
 * The picker is opened from inside the provider Drawer, but it is rendered as a
 * sibling of that Drawer rather than as a child of it, so it cannot inherit the
 * Drawer's stacking context and the two compete for the same base level. Relying
 * on antd's implicit per-mount ordering made the picker an overlay that could
 * land behind the Drawer; this states the intended order explicitly.
 *
 * Two steps clears one container (the Drawer) plus its mask. The base comes from
 * the live theme token rather than the literal 1000, so a themed base is
 * respected.
 */
const ANTD_CONTAINER_ZINDEX_STEP = 100;

interface IconPickerModalProps {
  open: boolean;
  currentIcon?: string;
  onSelect: (iconId: string) => void;
  onClose: () => void;
}

export const IconPickerModal: React.FC<IconPickerModalProps> = ({
  open,
  currentIcon,
  onSelect,
  onClose,
}) => {
  const t = useT();
  const { token } = theme.useToken();
  // Derived from the live theme token, so a themed z-index base is respected
  // rather than pinned to today's default of 1000.
  const zIndex = token.zIndexPopupBase + ANTD_CONTAINER_ZINDEX_STEP * 2;
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<'all' | 'provider' | 'model' | 'application'>('all');
  const [visibleIconIds, setVisibleIconIds] = useState<Set<string>>(new Set());
  const iconGridRef = useRef<HTMLDivElement | null>(null);

  const filteredIcons = useMemo(() => {
    const q = search.trim().toLowerCase();
    return LOBE_ICON_CATALOG.filter((item: LobeIconCatalogEntry) => {
      if (selectedGroup !== 'all' && item.group !== selectedGroup) {
        return false;
      }
      if (!q) return true;
      return (
        item.id.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.fullTitle.toLowerCase().includes(q) ||
        (item.desc && item.desc.toLowerCase().includes(q))
      );
    });
  }, [search, selectedGroup]);

  useEffect(() => {
    if (!open) {
      setVisibleIconIds(new Set());
      return;
    }
    const root = iconGridRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((items) => {
      setVisibleIconIds((previous) => {
        const next = new Set(previous);
        for (const item of items) {
          if (!item.isIntersecting) continue;
          const iconId = (item.target as HTMLElement).dataset.iconId;
          if (iconId) next.add(iconId);
        }
        return next;
      });
    }, { root, rootMargin: '240px 0px' });
    for (const node of root.querySelectorAll('[data-icon-id]')) observer.observe(node);
    return () => observer.disconnect();
  }, [filteredIcons, open]);

  const groupCounts = useMemo(() => {
    let provider = 0;
    let model = 0;
    let application = 0;
    for (const item of LOBE_ICON_CATALOG) {
      if (item.group === 'provider') provider++;
      else if (item.group === 'model') model++;
      else if (item.group === 'application') application++;
    }
    return { all: LOBE_ICON_CATALOG.length, provider, model, application };
  }, []);

  return (
    <Modal
      title={t('pro.icon_picker_title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      zIndex={zIndex}
    >
      <div style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
          placeholder={t('pro.search_icon_ph')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ marginBottom: 12 }}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tag.CheckableTag
            checked={selectedGroup === 'all'}
            onChange={() => setSelectedGroup('all')}
          >
            {t('common.all')} ({groupCounts.all})
          </Tag.CheckableTag>
          <Tag.CheckableTag
            checked={selectedGroup === 'provider'}
            onChange={() => setSelectedGroup('provider')}
          >
            {t('pro.group_providers')} ({groupCounts.provider})
          </Tag.CheckableTag>
          <Tag.CheckableTag
            checked={selectedGroup === 'model'}
            onChange={() => setSelectedGroup('model')}
          >
            {t('pro.group_models')} ({groupCounts.model})
          </Tag.CheckableTag>
          <Tag.CheckableTag
            checked={selectedGroup === 'application'}
            onChange={() => setSelectedGroup('application')}
          >
            {t('pro.group_apps')} ({groupCounts.application})
          </Tag.CheckableTag>
        </div>
      </div>

      <div
        ref={iconGridRef}
        style={{
          maxHeight: 420,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
          gap: 10,
          padding: '4px 2px',
        }}
      >
        {filteredIcons.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', padding: '40px 0' }}>
            <Empty description={t('pro.no_icons_found')} />
          </div>
        ) : (
          filteredIcons.map((item) => {
            const isSelected = item.id === currentIcon;
            return (
              <div
                key={item.id}
                data-icon-id={item.id}
                onClick={() => {
                  onSelect(item.id);
                  onClose();
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 4px',
                  borderRadius: 'var(--radius-sm, 4px)',
                  border: isSelected ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: isSelected ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'var(--surface)',
                  cursor: 'pointer',
                  transition: 'border-color var(--motion-fast, 50ms), background-color var(--motion-fast, 50ms)',
                  userSelect: 'none',
                }}
                title={`${item.fullTitle} (${item.id})`}
              >
                {visibleIconIds.has(item.id)
                  ? <LobeIcon iconId={item.id} size={28} loading="lazy" />
                  : <div aria-hidden="true" style={{ width: 28, height: 28 }} />}
                <div
                  style={{
                    fontSize: 11,
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    width: '100%',
                    padding: '0 4px',
                    color: isSelected ? 'var(--accent)' : 'var(--fg)',
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  {item.title || item.id}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
};
