import React from 'react';
import { SectionHeading } from '../common/SectionHeading';

interface SettingsGroupProps {
  id?: string;
  title: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}

/**
 * One section of the OMC settings page: a caption on the page ground and its rows in a single
 * enclosure below it. The rows share one box so a single edge shadow draws the card; drawn per row,
 * each row's drop would bleed across the seam into its neighbour.
 */
export function SettingsGroup({ id, title, children, testId }: SettingsGroupProps) {
  return (
    <div id={id} className="omc-settings-group" data-testid={testId}>
      <SectionHeading className="settings-group-head" title={title} />
      <div className="settings-group omc-settings-card">{children}</div>
    </div>
  );
}
