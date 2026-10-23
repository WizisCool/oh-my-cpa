import React from 'react';
import clsx from 'clsx';
import { Button, Modal, Tooltip } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useNavLayout } from '../../hooks/useNavLayout';
import { isHideableNavKey, navEntryLabel, type NavDropSide, type NavGroup } from '../../types/sidebarNav';
import { DownOutlined, HolderOutlined, UpOutlined } from '../icons';
import { collectPluginPages } from '../plugins/pluginPages';
import { buildNavGroups } from '../common/navigation';
import { SectionHeading } from '../common/SectionHeading';
import { SettingRow } from '../common/SettingRow';
import { Switch } from '../common/Switch';
import styles from './SidebarNavSettings.module.css';

/**
 * SidebarNavSettings is the rail's own layout setting - which entries it shows, and in what order -
 * one row on the OMC settings page, and the panel that row opens.
 *
 * The list is a dialog rather than a run of rows on the page. Which destinations a deployment cares
 * about is a decision an operator makes once, and the rail already has sixteen of them before any
 * plugin registers a page: inline, that would add a longer list than everything else on the page
 * put together, pushing the settings an operator does change each time below a list they change
 * once. The row states what the panel holds - how many entries are out of the rail - so the setting
 * reads without opening it, and the panel is where the rail itself is listed.
 *
 * The panel lists the rail rather than a hand-kept copy of it, from the same navigation model the
 * rail builds itself from, so the two cannot drift - a destination that exists is a row here, an
 * entry a later release adds is a row without the panel being touched, and the pages a running
 * plugin registered are rows too. An operator who does not use the Agent, the Playground or the
 * audit trail turns those off and gets a rail that is only what they use; the pages stay reachable
 * by URL and by whatever links point at them.
 *
 * Ordering is the same list's second job, and it is inside a group only: a group says what an entry
 * is, so dragging one across a heading would reclassify it rather than arrange it. A drag needs the
 * handle, so the panel's rows are not accidentally draggable while a switch is being operated, and
 * every row also carries earlier and later buttons, because a native drag reaches neither a
 * keyboard nor a touch screen.
 *
 * The rows are the console's ordinary setting rows - name, and a switch - with the entry's own icon
 * beside the name, because the icon is what the rail shows at 58px and it is how the operator
 * recognizes the entry they mean to move or hide. A hidden entry is dimmed but stays a row: it keeps
 * its position in the order, which is where it returns when it is shown again.
 *
 * One entry cannot be hidden: this page. A preference that could hide the surface that owns it
 * would let an operator put the console into a state they cannot undo from the console, so that row
 * is shown, switched on and disabled, with its reason stated. It can still be moved: the lock is
 * about reaching the setting, not about where the setting sits.
 *
 * Neither the row nor the panel carries a per-entry sentence: the group name says what it is, and
 * "Dashboard" needs no gloss - copy that only restates a label is the decorative text
 * `docs/design.md` §3 rules out.
 */
export const SidebarNavSettings: React.FC = () => {
  const t = useT();
  const [isPanelOpen, setIsPanelOpen] = React.useState(false);

  // The rail is built from the installed plugin list, so this panel names the plugin pages too.
  // Both queries are the ones the shell already holds, read for the same reason: no extra request
  // is made, and the list cannot disagree with the rail about what a plugin page is.
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth });
  const isCpaManageable = health !== undefined && health.cpa_management_api !== 'unsupported' && health.cpa_management_api !== 'disabled';
  const { data: pluginList } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    enabled: isCpaManageable,
    staleTime: 60_000,
  });
  const navGroups = React.useMemo(() => buildNavGroups(collectPluginPages(pluginList?.plugins)), [pluginList]);
  const { hidden, isHidden, loaded, order, orderedGroups, toggle, showAll, move, step, resetOrder } = useNavLayout(navGroups);
  // The stored document can name a key the current model does not draw - a plugin page whose
  // plugin stopped, for one - and such a key is not an entry the operator took out of the rail.
  // The row and the panel's reset both count what the rail would draw, so neither reports a
  // hidden entry that is not there, and the two cannot disagree about whether anything is hidden.
  const hiddenCount = React.useMemo(() => {
    const drawn = new Set(orderedGroups.flatMap((group) => group.items.map((entry) => entry.key)));
    return hidden.filter((key) => drawn.has(key)).length;
  }, [hidden, orderedGroups]);
  const hasCustomOrder = Object.keys(order).length > 0;

  return (
    <div className="settings-group omc-settings-group" data-testid="sidebar-nav-settings">
      <SectionHeading className="settings-group-head" title={t('omc.section_sidebar')} />
      <SettingRow
        label={t('omc.sidebar_entries')}
        description={hiddenCount > 0 ? t('omc.sidebar_hidden_count', { n: hiddenCount }) : t('omc.sidebar_all_shown')}
        control={<Button onClick={() => setIsPanelOpen(true)}>{t('omc.sidebar_manage')}</Button>}
      />
      <SidebarNavPanel
        open={isPanelOpen}
        groups={orderedGroups}
        isHidden={isHidden}
        canWrite={loaded}
        hasHidden={hiddenCount > 0}
        hasCustomOrder={hasCustomOrder}
        toggle={toggle}
        showAll={showAll}
        resetOrder={resetOrder}
        move={move}
        step={step}
        onClose={() => setIsPanelOpen(false)}
      />
    </div>
  );
};

interface NavDrag {
  key: string;
  groupKey: string;
}

/**
 * SidebarNavPanel is the rail, listed: every destination the rail can draw, in the rail's own order,
 * each with a switch and a pair of step buttons, and each draggable by its handle.
 *
 * The header's controls act on the list below it rather than sitting on the settings page, because
 * they are the list's own: with the rail intact neither has anything to do, and they are only ever
 * wanted after a change made here. "Show all" is visibility only and "Reset order" is order only, so
 * neither silently undoes the other.
 */
const SidebarNavPanel: React.FC<{
  open: boolean;
  groups: readonly NavGroup[];
  isHidden: (key: string) => boolean;
  canWrite: boolean;
  hasHidden: boolean;
  hasCustomOrder: boolean;
  toggle: (key: string, visible: boolean) => void;
  showAll: () => void;
  resetOrder: () => void;
  move: (key: string, targetKey: string, side: NavDropSide) => void;
  step: (key: string, direction: -1 | 1) => void;
  onClose: () => void;
}> = ({ open, groups, isHidden, canWrite, hasHidden, hasCustomOrder, toggle, showAll, resetOrder, move, step, onClose }) => {
  const t = useT();
  const [dragged, setDragged] = React.useState<NavDrag | null>(null);
  // A row is draggable only after its handle was pressed, so the row's text and switch stay
  // ordinary targets and the browser never starts a drag from the label.
  const [armedKey, setArmedKey] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ key: string; side: NavDropSide } | null>(null);

  const endDrag = () => {
    setDragged(null);
    setArmedKey(null);
    setDropTarget(null);
  };

  const dropSide = (event: React.DragEvent<HTMLElement>): NavDropSide => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  return (
    <Modal open={open} title={t('omc.section_sidebar')} onCancel={onClose} footer={null} width={560} destroyOnHidden>
      <div className={styles.dialog} data-testid="sidebar-nav-dialog">
        <SectionHeading
          level="label"
          as="h4"
          className={styles['panel-head']}
          title={t('omc.sidebar_entries')}
          extra={
            <>
              <Button size="small" onClick={resetOrder} disabled={!canWrite || !hasCustomOrder}>
                {t('omc.sidebar_reset_order')}
              </Button>
              <Button size="small" onClick={showAll} disabled={!canWrite || !hasHidden}>
                {t('omc.sidebar_show_all')}
              </Button>
            </>
          }
        />
        {groups.map((group) => (
          <React.Fragment key={group.key}>
            <SectionHeading level="label" as="h4" className={styles.subhead} title={t(group.labelKey)} />
            {group.items.map((entry, index) => {
              const label = navEntryLabel(entry, t);
              const isLocked = !isHideableNavKey(entry.key);
              const isEntryHidden = isHidden(entry.key);
              const drop = dropTarget?.key === entry.key ? dropTarget : null;
              return (
                <div
                  key={entry.key}
                  className={clsx(
                    styles.entry,
                    isEntryHidden && styles['is-hidden'],
                    dragged?.key === entry.key && styles['is-dragging'],
                  )}
                  data-nav-row={entry.key}
                  data-drop={drop?.side}
                  draggable={canWrite && armedKey === entry.key}
                  onDragStart={(event) => {
                    // A drag can also start from selected label text, and that one bubbles here too;
                    // only a handle press arms the row, so anything else is refused rather than
                    // reordering the rail from a gesture that never touched the handle.
                    if (armedKey !== entry.key) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', entry.key);
                    setDragged({ key: entry.key, groupKey: group.key });
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(event) => {
                    // A drop across a heading is not an ordering choice, so it is not offered:
                    // without `preventDefault` the browser never reports this row as a target.
                    if (!dragged || dragged.groupKey !== group.key || dragged.key === entry.key) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const side = dropSide(event);
                    setDropTarget((current) => (current?.key === entry.key && current.side === side ? current : { key: entry.key, side }));
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDropTarget((current) => (current?.key === entry.key ? null : current));
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragged && dragged.groupKey === group.key && dragged.key !== entry.key) {
                      move(dragged.key, entry.key, dropSide(event));
                    }
                    endDrag();
                  }}
                >
                  <SettingRow
                    label={
                      <span className={styles['row-label']}>
                        <Tooltip title={t('omc.sidebar_drag')}>
                          <span
                            className={styles.handle}
                            data-nav-handle={entry.key}
                            aria-hidden="true"
                            onPointerDown={() => { if (canWrite) setArmedKey(entry.key); }}
                            onPointerUp={() => { if (!dragged) setArmedKey(null); }}
                          >
                            <HolderOutlined />
                          </span>
                        </Tooltip>
                        <span className={styles['entry-icon']}>{entry.icon}</span>
                        {label}
                      </span>
                    }
                    description={isLocked ? t('omc.sidebar_locked') : undefined}
                    control={
                      <span className={styles.control}>
                        <span className={styles.steps}>
                          <Tooltip title={t('omc.sidebar_move_earlier')}>
                            <Button
                              size="small"
                              type="text"
                              icon={<UpOutlined />}
                              aria-label={`${t('omc.sidebar_move_earlier')} · ${label}`}
                              disabled={!canWrite || index === 0}
                              onClick={() => step(entry.key, -1)}
                            />
                          </Tooltip>
                          <Tooltip title={t('omc.sidebar_move_later')}>
                            <Button
                              size="small"
                              type="text"
                              icon={<DownOutlined />}
                              aria-label={`${t('omc.sidebar_move_later')} · ${label}`}
                              disabled={!canWrite || index === group.items.length - 1}
                              onClick={() => step(entry.key, 1)}
                            />
                          </Tooltip>
                        </span>
                        <span className={styles.toggle} data-nav-toggle={entry.key}>
                          <Switch
                            checked={!isEntryHidden}
                            disabled={isLocked || !canWrite}
                            aria-label={label}
                            onChange={(next) => toggle(entry.key, next)}
                          />
                        </span>
                      </span>
                    }
                  />
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </Modal>
  );
};
