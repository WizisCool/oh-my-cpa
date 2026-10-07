import React from 'react';
import { loadLucideIcons, lucideNodes, parseIconReference } from '../../../agent/agentIcons';
import type { LucideIconData } from '../../../agent/agentIcons';
import { LobeIcon } from '../../../components/LobeIcon';

let loadedIcons: LucideIconData | undefined;

/**
 * An icon a panel named (ADR 0071): a maker's mark, or any Lucide icon drawn from the lazily
 * loaded set. While the set loads, and for a name nothing answers to, the slot holds a neutral
 * mark of the same size, so a view's layout never depends on whether its icons resolved.
 */
export function AgentIcon({ icon, size = 14, className }: { icon?: string; size?: number; className?: string }) {
  const reference = React.useMemo(() => parseIconReference(icon), [icon]);
  const [icons, setIcons] = React.useState(loadedIcons);
  const needsIcons = reference?.kind === 'lucide' && !icons;
  React.useEffect(() => {
    if (!needsIcons) return;
    let isCurrent = true;
    // A set that fails to load leaves the neutral mark in place; the view is complete without it.
    loadLucideIcons().then(loaded => {
      loadedIcons = loaded;
      if (isCurrent) setIcons(loaded);
    }).catch(() => undefined);
    return () => { isCurrent = false; };
  }, [needsIcons]);
  if (reference?.kind === 'brand') return <LobeIcon iconId={reference.id} size={size} className={className} />;
  const nodes = reference && icons ? lucideNodes(icons, reference.name) : undefined;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={nodes ? reference?.name : 'neutral'}
    >
      {nodes
        ? nodes.map(([tag, attributes], index) => React.createElement(tag, { ...attributes, key: index }))
        : <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}
