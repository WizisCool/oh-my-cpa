import React from 'react';
import { Button, Modal } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useNavVisibility } from '../../hooks/useNavVisibility';
import { isHideableNavKey, navEntryLabel, type NavGroup } from '../../types/sidebarNav';
import { collectPluginPages } from '../plugins/pluginPages';
import { buildNavGroups } from '../common/navigation';
import { SectionHeading } from '../common/SectionHeading';
import { SettingRow } from '../common/SettingRow';
import { Switch } from '../common/Switch';
import styles from './SidebarNavSettings.module.css';

/**
 * SidebarNavSettings is the rail's own visibility setting: one row on the OMC settings page, and the
 * panel that row opens.
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
 * The rows are the console's ordinary setting rows - name, and a switch - with the entry's own icon
 * beside the name, because the icon is what the rail shows at 58px and it is how the operator
 * recognizes the entry they mean to hide.
 *
 * One entry cannot be hidden: this page. A preference that could hide the surface that owns it
 * would let an operator put the console into a state they cannot undo from the console, so that row
 * is shown, switched on and disabled, with its reason stated.
 *
 * Neither the row nor the panel carries a per-entry sentence: the group name says what it is, and
 * "Dashboard" needs no gloss - copy that only restates a label is the decorative text
 * `docs/design.md` §3 rules out.
 */
export const SidebarNavSettings: React.FC = () => {
  const t = useT();
  const { hidden, isHidden, ready, toggle, showAll } = useNavVisibility();
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
  // The stored document can name a key the current model does not draw - a plugin page whose
  // plugin stopped, for one - and such a key is not an entry the operator took out of the rail.
  // The row and the panel's reset both count what the rail would draw, so neither reports a
  // hidden entry that is not there, and the two cannot disagree about whether anything is hidden.
  const hiddenCount = React.useMemo(() => {
    const drawn = new Set(navGroups.flatMap((group) => group.items.map((entry) => entry.key)));
    return hidden.filter((key) => drawn.has(key)).length;
  }, [hidden, navGroups]);

  const canWrite = ready;
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
        groups={navGroups}
        isHidden={isHidden}
        canWrite={canWrite}
        hasHidden={hiddenCount > 0}
        toggle={toggle}
        showAll={showAll}
        onClose={() => setIsPanelOpen(false)}
      />
    </div>
  );
};

/**
 * SidebarNavPanel is the rail, listed: every destination the rail can draw, in the rail's own order,
 * each with a switch.
 *
 * "Show all" heads the list it resets rather than sitting on the page, because it is the panel's own
 * control: with the rail intact it has nothing to do, and it is only ever wanted after a change made
 * here.
 */
const SidebarNavPanel: React.FC<{
  open: boolean;
  groups: readonly NavGroup[];
  isHidden: (key: string) => boolean;
  canWrite: boolean;
  hasHidden: boolean;
  toggle: (key: string, visible: boolean) => void;
  showAll: () => void;
  onClose: () => void;
}> = ({ open, groups, isHidden, canWrite, hasHidden, toggle, showAll, onClose }) => {
  const t = useT();
  return (
    <Modal open={open} title={t('omc.section_sidebar')} onCancel={onClose} footer={null} width={560} destroyOnHidden>
      <div className={styles.dialog} data-testid="sidebar-nav-dialog">
        <SectionHeading
          level="label"
          as="h4"
          title={t('omc.sidebar_entries')}
          extra={
            <Button size="small" onClick={showAll} disabled={!canWrite || !hasHidden}>
              {t('omc.sidebar_show_all')}
            </Button>
          }
        />
        {groups.map((group) => (
          <React.Fragment key={group.key}>
            <SectionHeading level="label" as="h4" className={styles.subhead} title={t(group.labelKey)} />
            {group.items.map((entry) => {
              const label = navEntryLabel(entry, t);
              const isLocked = !isHideableNavKey(entry.key);
              return (
                <SettingRow
                  key={entry.key}
                  label={
                    <span className={styles['row-label']}>
                      {entry.icon}
                      {label}
                    </span>
                  }
                  description={isLocked ? t('omc.sidebar_locked') : undefined}
                  control={
                    <span className={styles.control} data-nav-toggle={entry.key}>
                      <Switch
                        checked={!isHidden(entry.key)}
                        disabled={isLocked || !canWrite}
                        aria-label={label}
                        onChange={(next) => toggle(entry.key, next)}
                      />
                    </span>
                  }
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </Modal>
  );
};
