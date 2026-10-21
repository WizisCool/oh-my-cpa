import React from 'react';

/**
 * SettingRow is one labelled setting: name on the left, control on the right.
 *
 * The description is optional because most settings name themselves - "Theme" needs no
 * sentence - and copy that only restates the label is the decorative text
 * `docs/design.md` §3 rules out. A description survives only where it states a fact the
 * label cannot: what a unit style changes, or what an abbreviated number is rounded from.
 */
export const SettingRow: React.FC<{
  label: React.ReactNode;
  description?: string;
  control: React.ReactNode;
  /** The control is a gallery wider than a control column (the palette cards): it takes the row's full width under the label. */
  isStacked?: boolean;
}> = ({
  label,
  description,
  control,
  isStacked = false,
}) => (
  <div className={`settings-toggle-row${isStacked ? ' is-stacked' : ''}`}>
    <div className="settings-toggle-info">
      <div className="settings-toggle-title">{label}</div>
      {description && <div className="settings-toggle-desc">{description}</div>}
    </div>
    <div className="settings-toggle-control">{control}</div>
  </div>
);
