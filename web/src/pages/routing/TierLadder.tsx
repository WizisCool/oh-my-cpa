import React from 'react';
import { Popover } from 'antd';
import { NumberInput } from '../../components/common/NumberInput';
import clsx from 'clsx';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, type AnimateLayoutChanges, type SortingStrategy } from '@dnd-kit/sortable';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { ProviderMark, CredentialMark } from '../../components/LobeIcon';
import { type ProviderBrandSources } from '../../types/brandMark';
import { ActionMenu } from '../../components/common/ActionMenu';
import { ToolButton } from '../../components/common/ToolButton';
import { StatusLabel } from '../../components/common/StatusLabel';
import { ArrowDownOutlined, ArrowLeftOutlined, ArrowRightOutlined, ArrowUpOutlined, HolderOutlined, VerticalAlignTopOutlined } from '../../components/icons';
import type { RoutingMember, RoutingStrategy } from '../../types/routing';
import type { RouteMemberState, RoutePreview, RouteStep, RoutingDropTarget, RoutingTier } from '../../types/routingPlan';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useWheelStep } from '../../hooks/useWheelStep';
import { useSortGuard } from '../../components/common/sortGuard';
import { useRoutingCardOrder } from './useRoutingCardOrder';
import styles from './RoutingPage.module.css';

const IN_TIER_KEYS: Record<RoutingStrategy, MessageKey> = {
  'round-robin': 'orch.tier_rr',
  'weighted-round-robin': 'orch.tier_wrr',
  'fill-first': 'orch.tier_ff',
};

// A member weighted to 0 carries no label: its chip already reads ×0 and the card's identity
// recedes, so a weight change does not widen the card and reflow its tier.
const STATE_KEYS: Partial<Record<RouteMemberState, MessageKey>> = {
  blocked: 'orch.state_blocked',
  unknown: 'orch.state_unknown',
};

export interface TierLadderProps {
  branding: ProviderBrandSources;
  tiers: RoutingTier[];
  members: ReadonlyMap<string, RoutingMember>;
  /** Priority each tier will be written with, in tier order. */
  tierPriorities: number[];
  strategy: RoutingStrategy;
  weights: Record<string, (number | null)[]>;
  preview: RoutePreview;
  /** True when the preview is narrowed to one model; only then is a member's share of traffic real. */
  isLens: boolean;
  /** Phones arrange through each card's menu; drag needs room the screen does not have. */
  canDrag: boolean;
  /** A submitted plan must settle before another edit can be made. */
  disabled?: boolean;
  /** The member the operator last moved; only it plays the landing motion. */
  landedKey: string | null;
  /** Drawn at the request's entry: the control that narrows the route to one model. */
  entry: React.ReactNode;
  /** What happens once every tier has failed, drawn at the route's end. */
  exit: React.ReactNode;
  onMove: (key: string, target: RoutingDropTarget) => void;
  onStep: (key: string, direction: 'up' | 'down') => void;
  onSplit: (key: string, side: 'above' | 'below') => void;
  onWeights: (key: string, weights: (number | null)[]) => void;
}

type DropData = RoutingDropTarget | { kind: 'card'; sortable?: { containerId: string } };

/** The card in hand: where it started and every tier's cards as the drag currently draws them. */
interface DragState {
  key: string;
  origin: string;
  tiers: RoutingTier[];
}

function tierOf(tiers: readonly RoutingTier[], key: string): string | undefined {
  return tiers.find((tier) => tier.memberKeys.includes(key))?.id;
}

/**
 * Cards differ in width and a tier wraps them onto rows, so no card can be shifted by the width of
 * another: the drag reorders the cards themselves and the browser lays the row out, and each card
 * that moved glides from where it was. A shift computed from the card in hand's width left gaps and
 * overlaps along a row of mixed widths.
 */
const LAID_OUT: SortingStrategy = () => null;
const MEASURE = { droppable: { strategy: MeasuringStrategy.Always } };
/** Cards glide to their new places while the drag sorts them; at the drop they are already there. */
const glideWhileSorting: AnimateLayoutChanges = ({ isSorting }) => isSorting;

/**
 * A link takes the pointer before anything else, a card before the tier it sits in. A pointer in a
 * tier's empty space resolves to the nearest card of that tier, so the card in hand lines up beside
 * it; a tier with no card to line up beside takes the card at its end.
 */
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const byId = new Map(args.droppableContainers.map((container) => [container.id, container]));
  const kindOf = (id: string | number) => (byId.get(id)?.data.current as DropData | undefined)?.kind;
  const gap = hits.find((hit) => kindOf(hit.id) === 'gap');
  if (gap) return [gap];
  const cards = hits.filter((hit) => kindOf(hit.id) === 'card');
  if (cards.length > 0) return cards;
  const tier = hits.find((hit) => kindOf(hit.id) === 'tier');
  if (!tier) return [];
  const tierId = (byId.get(tier.id)?.data.current as { tierId: string }).tierId;
  const peers = args.droppableContainers.filter((container) => {
    const data = container.data.current as DropData | undefined;
    return data?.kind === 'card' && data.sortable?.containerId === tierId;
  });
  return peers.length > 0 ? closestCenter({ ...args, droppableContainers: peers }) : [tier];
};

/**
 * The arrangement read as the path a request takes: it enters at the top, the first tier with an
 * able member serves it, and it falls through a link to the next tier only when the whole tier
 * above is unavailable, until it leaves at the bottom as an error.
 *
 * A card is sorted live while it is in hand: along its own tier the cards make room as it passes
 * them, and over another tier it joins that tier's row where the pointer is. Where a card sits in
 * its tier is presentation only; joining another tier is the change the plan writes. A link keeps
 * its height through a drag and only lights up as the place for a tier of the card's own, because
 * a link that grew under the pointer would push the route away from the hand.
 *
 * Without a model there is no share of traffic to draw: which members serve a request depends on
 * the model it asks for, so the route shows its order and the strategy, and the shares appear once
 * the lens names a model.
 */
export const TierLadder: React.FC<TierLadderProps> = (props) => {
  const { tiers, members, tierPriorities, strategy, preview, isLens, entry, exit, onMove } = props;
  const t = useT();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const steps = React.useMemo(() => new Map(preview.steps.map((step) => [step.tierId, step])), [preview]);
  const order = useRoutingCardOrder(tiers);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const guard = useSortGuard();
  const drawn = drag?.tiers ?? order.arranged;

  const handleDragStart = (event: DragStartEvent) => {
    const key = String(event.active.id);
    const origin = tierOf(order.arranged, key);
    guard.reset();
    if (origin) setDrag({ key, origin, tiers: order.arranged });
  };
  // Evaluated on every move as well as when the target changes, so a swap the guard held back while
  // a row reflowed happens once the hand moves on.
  const handleDragOver = ({ active, over, delta }: DragMoveEvent) => {
    const data = over?.data.current as DropData | undefined;
    if (!over || !data || data.kind === 'gap') return;
    if (data.kind === 'card' && !guard.shouldSwap(String(active.id), String(over.id), delta)) return;
    const target = data.kind === 'tier' ? data.tierId : data.sortable?.containerId;
    setDrag((current) => {
      if (!current || !target) return current;
      const from = tierOf(current.tiers, current.key);
      if (!from) return current;
      if (from === target) {
        if (data.kind !== 'card' || over.id === current.key) return current;
        return {
          ...current,
          tiers: current.tiers.map((tier) => tier.id === from
            ? { ...tier, memberKeys: arrayMove(tier.memberKeys, tier.memberKeys.indexOf(current.key), tier.memberKeys.indexOf(String(over.id))) }
            : tier),
        };
      }
      const into = current.tiers.find((tier) => tier.id === target)?.memberKeys ?? [];
      let index = into.length;
      if (data.kind === 'card') {
        const translated = active.rect.current.translated;
        const isAfter = Boolean(translated && translated.left + translated.width / 2 > over.rect.left + over.rect.width / 2);
        index = into.indexOf(String(over.id)) + (isAfter ? 1 : 0);
      }
      return {
        ...current,
        tiers: current.tiers.map((tier) => {
          if (tier.id === from) return { ...tier, memberKeys: tier.memberKeys.filter((key) => key !== current.key) };
          if (tier.id === target) return { ...tier, memberKeys: [...into.slice(0, index), current.key, ...into.slice(index)] };
          return tier;
        }),
      };
    });
  };
  // The drop keeps what the drag drew: the cards are already in their places, so nothing moves.
  const handleDragEnd = ({ over }: DragEndEvent) => {
    const current = drag;
    setDrag(null);
    const data = over?.data.current as DropData | undefined;
    if (!current || !over || !data) return;
    if (data.kind === 'gap') {
      presence.arm();
      onMove(current.key, data);
      return;
    }
    const tierId = tierOf(current.tiers, current.key);
    if (!tierId) return;
    if (tierId !== current.origin) {
      presence.arm();
      onMove(current.key, { kind: 'tier', tierId });
    }
    order.arrange(current.tiers);
  };
  /** A keyboard or menu move along the card's own tier. */
  const shift = (key: string, direction: -1 | 1) => {
    order.arrange(order.arranged.map((tier) => {
      const index = tier.memberKeys.indexOf(key);
      const to = index + direction;
      return index < 0 || to < 0 || to >= tier.memberKeys.length ? tier : { ...tier, memberKeys: arrayMove(tier.memberKeys, index, to) };
    }));
  };

  const presence = useTierPresence(drawn);
  const arranging: TierLadderProps = {
    ...props,
    onStep: (key, direction) => { presence.arm(); props.onStep(key, direction); },
    onSplit: (key, side) => { presence.arm(); props.onSplit(key, side); },
  };
  const dragged = drag ? members.get(drag.key) : undefined;
  const isDragging = Boolean(drag);
  const dropTier = drag ? tierOf(drag.tiers, drag.key) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={collide} measuring={MEASURE} onDragStart={handleDragStart} onDragMove={handleDragOver} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={() => setDrag(null)}>
      <div className={styles['flow']}>
        <div className={styles['flow-entry']}>
          <span className={styles['flow-node']} aria-hidden="true" />
          <span className={styles['flow-node-label']}>{t('orch.entry')}</span>
          {entry}
        </div>
        <ol className={styles['ladder']} aria-label={t('orch.ladder')}>
          <TierLink index={0} isActive={isDragging} />
          {presence.rows.map((row) => row.kind === 'leaving' ? (
            <TierExit key={`leaving-${row.tier.id}`} height={row.height} onDone={() => presence.release(row.tier.id)} />
          ) : (
            <React.Fragment key={row.tier.id}>
              <TierBand
                isEntering={presence.entering.has(row.tier.id)}
                measureRef={presence.measure(row.tier.id)}
                tier={row.tier}
                index={row.index}
                priority={tierPriorities[row.index]}
                strategy={strategy}
                step={steps.get(row.tier.id)}
                isLens={isLens}
                isTarget={Boolean(drag) && dropTier === row.tier.id && row.tier.id !== drag?.origin}
              >
                <SortableContext
                  id={row.tier.id}
                  items={row.tier.memberKeys.filter((key) => !(isLens && preview.states.get(key) === 'ineligible'))}
                  strategy={LAID_OUT}
                >
                  {row.tier.memberKeys.map((key, position) => {
                    const member = members.get(key);
                    return member ? (
                      <RoutingCard
                        key={key}
                        {...arranging}
                        member={member}
                        tierIndex={row.index}
                        tierCount={tiers.length}
                        isAlone={row.tier.memberKeys.length === 1}
                        isFirstInTier={position === 0}
                        isLastInTier={position === row.tier.memberKeys.length - 1}
                        isServingTier={steps.get(row.tier.id)?.isPrimary ?? false}
                        onShift={(direction) => shift(key, direction)}
                      />
                    ) : null;
                  })}
                </SortableContext>
              </TierBand>
              <TierLink index={row.index + 1} isActive={isDragging} />
            </React.Fragment>
          ))}
        </ol>
        <div className={styles['flow-exit']}>
          <span className={styles['flow-node']} aria-hidden="true" />
          <span className={styles['flow-node-label']}>{t('orch.exit')}</span>
          <span className={styles['flow-node-hint']}>{exit}</span>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged ? <CardFace branding={props.branding} member={dragged} className={styles['card-overlay']} /> : null}
      </DragOverlay>
    </DndContext>
  );
};

/**
 * The link between two tiers: the line a request falls down at rest, and while a card is in hand a
 * place for a tier of its own. The line says enough at rest; the label appears only for the drag.
 */
const TierLink: React.FC<{ index: number; isActive: boolean }> = ({ index, isActive }) => {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `gap-${index}`, data: { kind: 'gap', index } satisfies RoutingDropTarget, disabled: !isActive });
  return (
    <li
      ref={setNodeRef}
      data-gap={index}
      aria-hidden="true"
      className={clsx(styles['link'], isActive && styles['link-active'], isOver && styles['link-over'])}
    >
      {isActive && <span className={styles['link-label']}>{t('orch.new_tier_here')}</span>}
    </li>
  );
};

const TierBand: React.FC<{
  tier: RoutingTier;
  index: number;
  priority: number;
  strategy: RoutingStrategy;
  step?: RouteStep;
  isLens: boolean;
  /** The card in hand would join this tier if let go now. */
  isTarget: boolean;
  /** The tier was just opened by a move and unfolds into the route. */
  isEntering: boolean;
  measureRef: (element: HTMLElement | null) => void;
  children: React.ReactNode;
}> = ({ tier, index, priority, strategy, step, isLens, isTarget, isEntering, measureRef, children }) => {
  const t = useT();
  const { setNodeRef } = useDroppable({ id: `tier-${tier.id}`, data: { kind: 'tier', tierId: tier.id } satisfies RoutingDropTarget });
  const node = React.useRef<HTMLLIElement | null>(null);
  const ref = React.useCallback((element: HTMLLIElement | null) => {
    node.current = element;
    setNodeRef(element);
    measureRef(element);
  }, [measureRef, setNodeRef]);
  // An opened tier unfolds from the link it was dropped on: it grows from nothing to its height,
  // taking the new link's height with it, so the tiers below slide down instead of jumping.
  React.useLayoutEffect(() => {
    const element = node.current;
    if (!isEntering || !element || typeof element.animate !== 'function') return;
    const style = getComputedStyle(element);
    const height = element.getBoundingClientRect().height;
    element.animate([
      { height: '0px', marginTop: '-32px', paddingTop: '0px', paddingBottom: '0px', borderWidth: '0px', opacity: 0, overflow: 'hidden' },
      { height: `${height}px`, marginTop: '0px', paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderWidth: style.borderTopWidth, opacity: 1, overflow: 'hidden' },
    ], { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }, [isEntering]);
  const sharing = step?.members.filter((member) => member.state === 'serving' || member.state === 'standby').length ?? 0;
  let role: string;
  if (step?.isPrimary) {
    // Without a model nothing is known to be serving; the top reachable tier is only tried first.
    role = t(isLens ? 'orch.tier_serving' : 'orch.tier_first');
  } else if (step) {
    role = t('orch.tier_standby');
  } else {
    role = t(isLens ? 'orch.tier_skipped_model' : 'orch.tier_skipped');
  }
  return (
    <li
      ref={ref}
      className={clsx(styles['tier'], isTarget && styles['tier-over'], step?.isPrimary && styles['tier-primary'], !step && styles['tier-skipped'])}
      aria-label={t('orch.tier', { n: index + 1 })}
    >
      <div className={styles['tier-gutter']}>
        <span className={styles['tier-step']}>{index + 1}</span>
        <span className={styles['tier-meta']}>
          <span className={styles['tier-name']}>{t('orch.tier', { n: index + 1 })}</span>
          <span className={styles['tier-priority']}>{t('omc.priority_value', { n: priority })}</span>
        </span>
      </div>
      <div className={styles['tier-body']}>
        <span className={styles['tier-role']}>
          {role}
          {sharing > 1 && <> · {t(IN_TIER_KEYS[strategy])}</>}
        </span>
        <ul className={clsx(styles['tier-cards'], tier.memberKeys.length === 0 && styles['tier-cards-vacant'])}>{children}</ul>
      </div>
    </li>
  );
};

type LadderRow =
  | { kind: 'tier'; tier: RoutingTier; index: number }
  | { kind: 'leaving'; tier: RoutingTier; height: number };

/**
 * Tiers that a move opens or closes come and go with the move rather than appearing between frames:
 * an opened tier unfolds into the route and a closed one folds away where it stood. Only a move the
 * operator made here is animated, armed just before it is handed up; a board read from the server
 * (a reload, an applied plan) renumbers its tiers and is drawn as it is.
 */
function useTierPresence(tiers: readonly RoutingTier[]) {
  const isReduced = usePrefersReducedMotion();
  const isArmed = React.useRef(false);
  const previous = React.useRef(tiers);
  const heights = React.useRef(new Map<string, number>());
  const elements = React.useRef(new Map<string, HTMLElement>());
  const [leaving, setLeaving] = React.useState<{ tier: RoutingTier; after: string | null; height: number }[]>([]);
  const [entering, setEntering] = React.useState<ReadonlySet<string>>(new Set());

  React.useLayoutEffect(() => {
    const before = previous.current;
    previous.current = tiers;
    if (before === tiers || !isArmed.current) return;
    isArmed.current = false;
    if (isReduced) return;
    const now = new Set(tiers.map((tier) => tier.id));
    const was = new Set(before.map((tier) => tier.id));
    const gone = before.flatMap((tier, index) => {
      if (now.has(tier.id)) return [];
      // A closed tier folds away after the last surviving tier that stood above it.
      const above = before.slice(0, index).reverse().find((candidate) => now.has(candidate.id));
      return [{ tier, after: above?.id ?? null, height: heights.current.get(tier.id) ?? 0 }];
    });
    const opened = tiers.filter((tier) => !was.has(tier.id)).map((tier) => tier.id);
    if (gone.length > 0) setLeaving(gone);
    if (opened.length > 0) setEntering(new Set(opened));
  }, [isReduced, tiers]);

  React.useEffect(() => {
    if (entering.size === 0) return undefined;
    const timer = window.setTimeout(() => setEntering(new Set()), 400);
    return () => window.clearTimeout(timer);
  }, [entering]);

  const measurers = React.useRef(new Map<string, (element: HTMLElement | null) => void>());
  const measure = (id: string) => {
    let measurer = measurers.current.get(id);
    if (!measurer) {
      measurer = (element) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      };
      measurers.current.set(id, measurer);
    }
    return measurer;
  };

  const rows: LadderRow[] = [];
  const pending = leaving.filter((entry) => entry.after === null);
  for (const entry of pending) rows.push({ kind: 'leaving', tier: entry.tier, height: entry.height });
  tiers.forEach((tier, index) => {
    rows.push({ kind: 'tier', tier, index });
    for (const entry of leaving) {
      if (entry.after === tier.id) rows.push({ kind: 'leaving', tier: entry.tier, height: entry.height });
    }
  });

  return {
    rows,
    entering,
    measure,
    // Armed before the move is handed up, while the tiers it may close are still on the page.
    arm: () => {
      isArmed.current = true;
      for (const [id, element] of elements.current) heights.current.set(id, element.getBoundingClientRect().height);
    },
    release: (id: string) => setLeaving((current) => current.filter((entry) => entry.tier.id !== id)),
  };
}

/** A closed tier and its link, folding from their height to nothing. */
const TierExit: React.FC<{ height: number; onDone: () => void }> = ({ height, onDone }) => (
  <li
    aria-hidden="true"
    className={styles['tier-exit']}
    style={{ '--exit-height': `${height + 32}px` } as React.CSSProperties}
    onAnimationEnd={(event) => { if (event.target === event.currentTarget) onDone(); }}
  />
);

/** The card's own face, shared by the resting card and the one following the pointer. */
const CardFace: React.FC<{ branding: ProviderBrandSources; member: RoutingMember; className?: string; children?: React.ReactNode }> = ({ member, branding, className, children }) => {
  const t = useT();
  return (
    <div className={clsx(styles['card-face'], className)}>
      <HolderOutlined className={styles['card-grip']} aria-hidden="true" />
      {member.kind === 'provider'
        ? <ProviderMark provider={member} sources={branding} size={20} />
        : <CredentialMark provider={member.family} hint={member.name} pluginLogos={branding.pluginLogos} size={20} />}
      <span className={styles['card-text']}>
        <span className={styles['card-name']}>{member.name}</span>
        <span className={styles['card-sub']}>
          {t(member.kind === 'provider' ? 'orch.kind_provider' : 'orch.kind_credential')}
          {member.key_count > 1 && <> · {t('orch.key_count', { n: member.key_count })}</>}
          {member.prefix && <> · <code>{member.prefix}/</code></>}
        </span>
      </span>
      {children}
    </div>
  );
};

interface RoutingCardProps extends TierLadderProps {
  member: RoutingMember;
  tierIndex: number;
  tierCount: number;
  isAlone: boolean;
  isFirstInTier: boolean;
  isLastInTier: boolean;
  /** The tier requests reach first; only its shares are drawn as live traffic. */
  isServingTier: boolean;
  /** Moves the card a place along its tier: where it is drawn, not how it is routed. */
  onShift: (direction: -1 | 1) => void;
}

const RoutingCard: React.FC<RoutingCardProps> = ({
  member, branding, tierIndex, tierCount, isAlone, isFirstInTier, isLastInTier, isServingTier, canDrag, disabled = false, strategy, weights, preview, isLens, landedKey, onStep, onSplit, onWeights, onShift,
}) => {
  const t = useT();
  const state = preview.states.get(member.key);
  const isHidden = isLens && state === 'ineligible';
  const isLocked = member.is_runtime_only || disabled || isHidden;
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: member.key, data: { kind: 'card' }, disabled: !canDrag || isLocked, animateLayoutChanges: glideWhileSorting,
  });
  const travel: React.CSSProperties | undefined = transform || transition
    ? { transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }
    : undefined;
  const share = preview.steps.flatMap((step) => step.members).find((entry) => entry.key === member.key)?.share;
  const memberWeights = weights[member.key] ?? [];
  const canMoveUp = !disabled && !isHidden && (tierIndex > 0 || !isAlone);
  const canMoveDown = !disabled && !isHidden && (tierIndex < tierCount - 1 || !isAlone);
  const canShiftBefore = !isHidden && !isFirstInTier;
  const canShiftAfter = !isHidden && !isLastInTier;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey || event.target !== event.currentTarget) return;
    if (event.key === 'ArrowLeft' && canShiftBefore) {
      event.preventDefault();
      onShift(-1);
      return;
    }
    if (event.key === 'ArrowRight' && canShiftAfter) {
      event.preventDefault();
      onShift(1);
      return;
    }
    if (isLocked) return;
    if (event.key === 'ArrowUp' && canMoveUp) {
      event.preventDefault();
      onStep(member.key, 'up');
    } else if (event.key === 'ArrowDown' && canMoveDown) {
      event.preventDefault();
      onStep(member.key, 'down');
    }
  };
  const liRef = React.useRef<HTMLLIElement | null>(null);
  // The card keeps focus across a keyboard move: it remounts in its new tier, so focus follows it.
  const focusRef = React.useCallback((element: HTMLLIElement | null) => {
    liRef.current = element;
    setNodeRef(element);
    if (element && landedKey === member.key && document.activeElement === document.body && !isHidden) {
      element.focus({ preventScroll: true });
    }
  }, [setNodeRef, landedKey, member.key, isHidden]);

  React.useEffect(() => {
    if (liRef.current) {
      if (isHidden) {
        liRef.current.setAttribute('inert', '');
      } else {
        liRef.current.removeAttribute('inert');
      }
    }
  }, [isHidden]);

  return (
    <li
      ref={focusRef}
      tabIndex={isHidden ? -1 : 0}
      aria-hidden={isHidden ? 'true' : undefined}
      aria-keyshortcuts={isLocked ? 'Alt+ArrowLeft Alt+ArrowRight' : 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight'}
      aria-label={member.name}
      onKeyDown={handleKeyDown}
      className={clsx(
        styles['card'],
        canDrag && !isLocked && styles['card-draggable'],
        isDragging && styles['card-placeholder'],
        landedKey === member.key && styles['card-landed'],
        (member.is_disabled || state === 'ineligible') && styles['card-muted'],
        state === 'excluded' && styles['card-excluded'],
        isHidden && styles['card-hidden'],
      )}
      data-member={member.key}
      style={travel}
      {...(canDrag && !isLocked ? listeners : {})}
    >
      <CardFace branding={branding} member={member}>
        {isLens && isServingTier && typeof share === 'number' && (
          <span className={styles['card-share-bar']} style={{ '--share': share } as React.CSSProperties} aria-hidden="true" />
        )}
        {/* The card's own controls take their pointer for themselves rather than starting a drag. */}
        <span className={styles['card-end']} onPointerDown={(event) => event.stopPropagation()}>
          {member.is_disabled && <StatusLabel tone="neutral">{t('orch.state_disabled')}</StatusLabel>}
          {member.is_runtime_only && <StatusLabel tone="neutral" title={t('orch.state_runtime_hint')}>{t('orch.state_runtime')}</StatusLabel>}
          {state && STATE_KEYS[state] && <StatusLabel tone={state === 'blocked' ? 'warn' : 'neutral'}>{t(STATE_KEYS[state]!)}</StatusLabel>}
          {isLens && (state === 'serving' || state === 'standby') && (
            <span className={clsx(styles['card-share'], !isServingTier && styles['card-share-idle'])}>
              {share === null || share === undefined ? t('orch.state_fill') : `${Math.round(share * 100)}%`}
            </span>
          )}
          {strategy === 'weighted-round-robin' && memberWeights.length > 0 && (
            <WeightControl member={member} weights={memberWeights} isLocked={isLocked} onChange={(next) => onWeights(member.key, next)} />
          )}
          {!member.is_runtime_only && (
            <ActionMenu label={t('orch.card_actions')}>
              <ToolButton icon={<ArrowUpOutlined />} label={t('orch.move_up')} disabled={!canMoveUp} onClick={() => onStep(member.key, 'up')} />
              <ToolButton icon={<ArrowDownOutlined />} label={t('orch.move_down')} disabled={!canMoveDown} onClick={() => onStep(member.key, 'down')} />
              <ToolButton icon={<ArrowLeftOutlined />} label={t('orch.move_before')} disabled={!canShiftBefore} onClick={() => onShift(-1)} />
              <ToolButton icon={<ArrowRightOutlined />} label={t('orch.move_after')} disabled={!canShiftAfter} onClick={() => onShift(1)} />
              <ToolButton icon={<VerticalAlignTopOutlined />} label={t('orch.split_above')} disabled={disabled || isAlone} onClick={() => onSplit(member.key, 'above')} />
              <ToolButton icon={<VerticalAlignTopOutlined rotate={180} />} label={t('orch.split_below')} disabled={disabled || isAlone} onClick={() => onSplit(member.key, 'below')} />
            </ActionMenu>
          )}
        </span>
      </CardFace>
    </li>
  );
};

const MAX_WEIGHT = 1_000_000;

/** One weight per key; an empty field runs as CPA's default of 1. */
const WeightControl: React.FC<{
  member: RoutingMember;
  weights: (number | null)[];
  isLocked: boolean;
  onChange: (weights: (number | null)[]) => void;
}> = ({ member, weights, isLocked, onChange }) => {
  const t = useT();
  const total = weights.reduce<number>((sum, weight) => sum + (weight ?? 1), 0);
  // A member with one key is weighted from its chip too: the wheel over it steps the weight, as it
  // does over the field the chip opens. Several keys have no one weight to step.
  const [chip, setChip] = React.useState<HTMLButtonElement | null>(null);
  useWheelStep(chip, (isUp) => {
    const next = Math.min(Math.max((weights[0] ?? 1) + (isUp ? 1 : -1), 0), MAX_WEIGHT);
    if (next !== (weights[0] ?? 1)) onChange([next]);
  }, !isLocked && weights.length === 1);
  const content = (
    <div className={styles['weight-editor']}>
      {weights.map((weight, index) => (
        <label key={member.weights[index]?.index ?? index} className={styles['weight-row']}>
          <span>{weights.length > 1 ? t('orch.weight_key', { n: index + 1 }) : t('orch.weight')}</span>
          <NumberInput
            size="small"
            min={0}
            max={MAX_WEIGHT}
            precision={0}
            placeholder="1"
            value={weight}
            disabled={isLocked}
            onChange={(value) => onChange(weights.map((entry, position) => (position === index ? (value ?? null) : entry)))}
          />
        </label>
      ))}
      <span className={styles['policy-hint']}>{t('orch.weight_hint')}</span>
    </div>
  );
  return (
    <Popover trigger="click" placement="bottomRight" content={content}>
      <button type="button" ref={setChip} className={styles['weight-chip']} aria-label={t('orch.weight_named', { name: member.name })}>
        ×{total}
      </button>
    </Popover>
  );
};
