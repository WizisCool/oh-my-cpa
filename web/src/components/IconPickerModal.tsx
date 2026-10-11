import { CustomIconLibrary } from './CustomIconLibrary';
import { shouldCloseIconPicker } from '../types/customIcons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Segmented, theme } from 'antd';
import {
  LOBE_ICON_CATALOG,
  type LobeIconCatalogEntry,
} from '../types/lobeIconCatalog';
import { LobeIcon } from './LobeIcon';
import { useT } from '../i18n';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import { SearchInput } from './common/SearchInput';
import { EmptyState } from './common/EmptyState';
import { ToggleTag } from './common/Tag';
import styles from './IconPickerModal.module.css';

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
  onSelect: (iconId: string) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}

export const IconPickerModal: React.FC<IconPickerModalProps> = ({
  open,
  currentIcon,
  onSelect,
  onClose,
  onDeleted,
}) => {
  const t = useT();
  const [isLibraryBusy, setIsLibraryBusy] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  useOverlayHistory({
    isOpen: open,
    onClose: () => {
      if (!isSelecting && !isLibraryBusy) onClose();
    },
  });
  const { token } = theme.useToken();
  // Derived from the live theme token, so a themed z-index base is respected
  // rather than pinned to today's default of 1000.
  const zIndex = token.zIndexPopupBase + ANTD_CONTAINER_ZINDEX_STEP * 2;
  const [tab, setTab] = useState<'builtin' | 'custom'>('builtin');
  useEffect(() => {
    if (open) setTab(currentIcon?.startsWith('custom:') ? 'custom' : 'builtin');
  }, [open]);
  const selectIcon = async (reference: string) => {
    setIsSelecting(true);
    try {
      if (shouldCloseIconPicker(await onSelect(reference))) onClose();
    } finally {
      setIsSelecting(false);
    }
  };
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<
    'all' | 'provider' | 'model' | 'application'
  >('all');
  const [visibleIconIds, setVisibleIconIds] = useState<Set<string>>(new Set());
  // The grid node is state rather than a ref, because antd mounts the dialog panel
  // asynchronously and on the very first open the effect below runs while the node
  // does not exist yet. A ref would read `null` that one time and never re-run -
  // the dependency list does not change when the node finally appears - so nothing
  // was ever observed and the first open rendered every tile as an empty box.
  const [iconGridNode, setIconGridNode] = useState<HTMLDivElement | null>(null);
  const attachIconGrid = useCallback(
    (node: HTMLDivElement | null) => setIconGridNode(node),
    [],
  );

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
    if (!iconGridNode) return;
    const observer = new IntersectionObserver(
      (items) => {
        setVisibleIconIds((previous) => {
          const next = new Set(previous);
          for (const item of items) {
            if (!item.isIntersecting) continue;
            const iconId = (item.target as HTMLElement).dataset.iconId;
            if (iconId) next.add(iconId);
          }
          return next;
        });
      },
      { root: iconGridNode, rootMargin: '240px 0px' },
    );
    for (const node of iconGridNode.querySelectorAll('[data-icon-id]'))
      observer.observe(node);
    return () => observer.disconnect();
  }, [filteredIcons, open, iconGridNode]);

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
      onCancel={() => {
        if (!isSelecting && !isLibraryBusy) onClose();
      }}
      footer={null}
      width={720}
      // antd's `styles` is the only route to the dialog body, which the module cannot name.
      styles={{
        body: { maxHeight: 'calc(100dvh - 180px)', overflowY: 'auto' },
      }}
      destroyOnHidden
      zIndex={zIndex}
    >
      <Segmented
        className={styles['source-tabs']}
        value={tab}
        disabled={isSelecting || isLibraryBusy}
        options={[
          { value: 'builtin', label: t('icons.builtin') },
          { value: 'custom', label: t('icons.custom') },
        ]}
        onChange={(value) => setTab(value as 'builtin' | 'custom')}
      />
      {tab === 'custom' ? (
        <CustomIconLibrary
          currentIcon={currentIcon}
          onSelect={selectIcon}
          onDeleted={onDeleted}
          onBusyChange={setIsLibraryBusy}
          isSelecting={isSelecting}
        />
      ) : (
        <>
          <div className={styles['filters']}>
            <SearchInput
              label={t('pro.search_icon_ph')}
              value={search}
              onChange={setSearch}
              className={styles['search']}
              autoFocus
            />

            <div className={styles['groups']}>
              <ToggleTag
                checked={selectedGroup === 'all'}
                onChange={() => setSelectedGroup('all')}
              >
                {t('common.all')} ({groupCounts.all})
              </ToggleTag>
              <ToggleTag
                checked={selectedGroup === 'provider'}
                onChange={() => setSelectedGroup('provider')}
              >
                {t('pro.group_providers')} ({groupCounts.provider})
              </ToggleTag>
              <ToggleTag
                checked={selectedGroup === 'model'}
                onChange={() => setSelectedGroup('model')}
              >
                {t('pro.group_models')} ({groupCounts.model})
              </ToggleTag>
              <ToggleTag
                checked={selectedGroup === 'application'}
                onChange={() => setSelectedGroup('application')}
              >
                {t('pro.group_apps')} ({groupCounts.application})
              </ToggleTag>
            </div>
          </div>

          <div
            ref={attachIconGrid}
            className={styles['grid']}
          >
            {filteredIcons.length === 0 ? (
              <div className={styles['grid-empty']}>
                <EmptyState title={t('pro.no_icons_found')} />
              </div>
            ) : (
              filteredIcons.map((item) => {
                const isSelected = item.id === currentIcon;
                return (
                  <div
                    key={item.id}
                    data-icon-id={item.id}
                    role="button"
                    tabIndex={isSelecting ? -1 : 0}
                    aria-pressed={isSelected}
                    aria-disabled={isSelecting}
                    onClick={() => {
                      if (!isSelecting) void selectIcon(item.id);
                    }}
                    onKeyDown={(event) => {
                      if (
                        !isSelecting &&
                        (event.key === 'Enter' || event.key === ' ')
                      ) {
                        event.preventDefault();
                        void selectIcon(item.id);
                      }
                    }}
                    className={styles['tile']}
                    title={`${item.fullTitle} (${item.id})`}
                  >
                    {visibleIconIds.has(item.id) ? (
                      <LobeIcon iconId={item.id} size={28} loading="lazy" />
                    ) : (
                      <div aria-hidden="true" className={styles['tile-placeholder']} />
                    )}
                    <div className={styles['tile-name']}>
                      {item.title || item.id}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </Modal>
  );
};
