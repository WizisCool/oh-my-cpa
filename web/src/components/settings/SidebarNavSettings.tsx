import React from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useNavVisibility } from '../../hooks/useNavVisibility';
import { isHideableNavKey, navEntryLabel } from '../../types/sidebarNav';
import { collectPluginPages } from '../plugins/pluginPages';
import { buildNavGroups } from '../common/navigation';
import { SectionHeading } from '../common/SectionHeading';
import { SettingRow } from '../common/SettingRow';
import { Switch } from '../common/Switch';
import styles from './SidebarNavSettings.module.css';

/**
 * SidebarNavSettings is the rail's own visibility panel: every destination the rail can show, in
 * the rail's own order, each with a switch.
 *
 * It lists the rail rather than a hand-kept copy of it, from the same navigation model the rail
 * builds itself from, so the two cannot drift - a destination that exists is a row here, including
 * the pages a running plugin registered. An operator who does not use the Agent, the Playground or
 * the audit trail turns those off and gets a rail that is only what they use; the pages stay
 * reachable by URL and by whatever links point at them.
 *
 * The rows are the console's ordinary setting rows - name, and a switch - with the entry's own icon
 * beside the name, because the icon is what the rail shows at 58px and it is how the operator
 * recognizes the entry they mean to hide.
 *
 * One entry cannot be hidden: this page. A preference that could hide the surface that owns it
 * would let an operator put the console into a state they cannot undo from the console, so that row
 * is shown, switched on and disabled, with its reason stated.
 *
 * The panel carries no group description and no per-entry sentence: the group name says what it is,
 * and "Dashboard" needs no gloss - copy that only restates a label is the decorative text
 * `docs/design.md` §3 rules out.
 */
export const SidebarNavSettings: React.FC = () => {
  const t = useT();
  const { hidden, isHidden, ready, toggle, showAll } = useNavVisibility();

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

  const canWrite = ready;
  return (
    <div className="settings-group omc-settings-group" data-testid="sidebar-nav-settings">
      <SectionHeading
        className="settings-group-head"
        title={t('omc.section_sidebar')}
        extra={
          <Button size="small" onClick={showAll} disabled={!canWrite || hidden.length === 0}>
            {t('omc.sidebar_show_all')}
          </Button>
        }
      />
      {navGroups.map((group) => (
        <React.Fragment key={group.key}>
          <SectionHeading level="label" as="h4" className={styles['subhead']} title={t(group.labelKey)} />
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
                  <span className={styles['control']} data-nav-toggle={entry.key}>
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
  );
};
