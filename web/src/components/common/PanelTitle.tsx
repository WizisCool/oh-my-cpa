import React from 'react';

export interface PanelTitleProps {
  /** An optional glyph; it takes the muted ink so the title, not the icon, carries the weight. */
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** A control that acts on this panel alone, pinned to the head's right edge. */
  extra?: React.ReactNode;
}

/**
 * A card's head: glyph, title and the one control that acts on that card.
 *
 * Pages used to build this inline with a flex `div` per card, which is how the same head came to
 * have three gaps and two icon colours on one page. `extra` lives here rather than in antd's own
 * `extra` slot so that it wraps below the title on a narrow card instead of overlapping it.
 */
export function PanelTitle({ icon, children, extra }: PanelTitleProps) {
  return (
    <div className="panel-title">
      <span className="panel-title-main">
        {icon !== undefined && <span className="panel-title-icon">{icon}</span>}
        <span className="panel-title-text">{children}</span>
      </span>
      {extra !== undefined && extra !== null && <span className="panel-title-extra">{extra}</span>}
    </div>
  );
}
