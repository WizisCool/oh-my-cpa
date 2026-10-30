import React from 'react';
import { InputNumber, Popover } from 'antd';
import clsx from 'clsx';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { credentialProviderIconId } from '../../components/common/providerMetadata';
import { ActionMenu } from '../../components/common/ActionMenu';
import { ToolButton } from '../../components/common/ToolButton';
import { StatusLabel } from '../../components/common/StatusLabel';
import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined, VerticalAlignTopOutlined } from '../../components/icons';
import type { RoutingMember, RoutingStrategy } from '../../types/routing';
import type { RouteMemberState, RoutePreview, RouteStep, RoutingDropTarget, RoutingTier } from '../../types/routingPlan';
import styles from './RoutingPage.module.css';

const IN_TIER_KEYS: Record<RoutingStrategy, MessageKey> = {
  'round-robin': 'orch.tier_rr',
  'weighted-round-robin': 'orch.tier_wrr',
  'fill-first': 'orch.tier_ff',
};

const STATE_KEYS: Partial<Record<RouteMemberState, MessageKey>> = {
  excluded: 'orch.state_excluded',
  blocked: 'orch.state_blocked',
  unknown: 'orch.state_unknown',
};

export interface TierLadderProps {
  tiers: RoutingTier[];
  members: ReadonlyMap<string, RoutingMember>;
  /** Priority each tier will be written with, in tier order. */
  tierPriorities: number[];
  strategy: RoutingStrategy;
  weights: Record<string, (number | null)[]>;
  preview: RoutePreview;
  /** True when the preview is narrowed to one model, so tiers that cannot serve it recede. */
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

/**
 * The arrangement read as the path a request takes: it enters at the top, the first tier with an
 * able member serves it, and it falls through a link to the next tier only when the whole tier
 * above is unavailable, until it leaves at the bottom as an error.
 *
 * A card dropped on a tier joins it; dropped on a link it opens a tier of its own there. The links
 * hold their height at rest, so lifting a card moves nothing on the page: the drag overlay starts
 * from the card's measured place, and a ladder that grew as the drag began left it short of the hand.
 */
export const TierLadder: React.FC<TierLadderProps> = (props) => {
  const { tiers, members, tierPriorities, strategy, preview, isLens, entry, exit, onMove } = props;
  const t = useT();
  const [draggingKey, setDraggingKey] = React.useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const steps = React.useMemo(() => new Map(preview.steps.map((step) => [step.tierId, step])), [preview]);

  const handleDragStart = (event: DragStartEvent) => setDraggingKey(String(event.active.id));
  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingKey(null);
    const target = event.over?.data.current as RoutingDropTarget | undefined;
    if (target) {
      onMove(String(event.active.id), target);
    }
  };
  const dragged = draggingKey ? members.get(draggingKey) : undefined;
  const isDragging = Boolean(draggingKey);

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDraggingKey(null)}>
      <div className={styles['flow']}>
        <div className={styles['flow-entry']}>
          <span className={styles['flow-node']} aria-hidden="true" />
          <span className={styles['flow-node-label']}>{t('orch.entry')}</span>
          {entry}
        </div>
        <ol className={styles['ladder']} aria-label={t('orch.ladder')}>
          <TierLink index={0} isActive={isDragging} />
          {tiers.map((tier, index) => (
            <React.Fragment key={tier.id}>
              <TierBand
                tier={tier}
                index={index}
                priority={tierPriorities[index]}
                strategy={strategy}
                step={steps.get(tier.id)}
                isLens={isLens}
              >
                {tier.memberKeys.map((key) => {
                  const member = members.get(key);
                  return member ? (
                    <RoutingCard
                      key={key}
                      {...props}
                      member={member}
                      tierIndex={index}
                      tierCount={tiers.length}
                      isAlone={tier.memberKeys.length === 1}
                      isServingTier={steps.get(tier.id)?.isPrimary ?? false}
                    />
                  ) : null;
                })}
              </TierBand>
              <TierLink index={index + 1} isActive={isDragging} label={t('orch.fallthrough')} />
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
        {dragged ? <CardFace member={dragged} className={styles['card-overlay']} /> : null}
      </DragOverlay>
    </DndContext>
  );
};

/** The link between two tiers: where a request falls through at rest, a new tier's place in a drag. */
const TierLink: React.FC<{ index: number; isActive: boolean; label?: string }> = ({ index, isActive, label }) => {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `gap-${index}`, data: { kind: 'gap', index } satisfies RoutingDropTarget, disabled: !isActive });
  return (
    <li
      ref={setNodeRef}
      data-gap={index}
      aria-hidden="true"
      className={clsx(styles['link'], isActive && styles['link-active'], isOver && styles['link-over'])}
    >
      <span className={styles['link-label']}>{isActive ? t('orch.new_tier_here') : label}</span>
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
  children: React.ReactNode;
}> = ({ tier, index, priority, strategy, step, isLens, children }) => {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `tier-${tier.id}`, data: { kind: 'tier', tierId: tier.id } satisfies RoutingDropTarget });
  const sharing = step?.members.filter((member) => member.state === 'serving' || member.state === 'standby').length ?? 0;
  let role: string;
  if (step?.isPrimary) {
    role = t('orch.tier_serving');
  } else if (step) {
    role = t('orch.tier_standby');
  } else {
    role = t(isLens ? 'orch.tier_skipped_model' : 'orch.tier_skipped');
  }
  return (
    <li
      ref={setNodeRef}
      className={clsx(styles['tier'], isOver && styles['tier-over'], step?.isPrimary && styles['tier-primary'], !step && styles['tier-skipped'])}
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
        <ul className={styles['tier-cards']}>{children}</ul>
      </div>
    </li>
  );
};

/** The card's own face, shared by the resting card and the one following the pointer. */
const CardFace: React.FC<{ member: RoutingMember; className?: string; children?: React.ReactNode }> = ({ member, className, children }) => {
  const t = useT();
  return (
    <div className={clsx(styles['card-face'], className)}>
      <HolderOutlined className={styles['card-grip']} aria-hidden="true" />
      <ProviderBrandIcon iconId={credentialProviderIconId(member.family, member.name)} size={20} />
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
  /** The tier requests reach first; only its shares are drawn as live traffic. */
  isServingTier: boolean;
}

const RoutingCard: React.FC<RoutingCardProps> = ({
  member, tierIndex, tierCount, isAlone, isServingTier, canDrag, disabled = false, strategy, weights, preview, isLens, landedKey, onStep, onSplit, onWeights,
}) => {
  const t = useT();
  const state = preview.states.get(member.key);
  const isHidden = isLens && state === 'ineligible';
  const isLocked = member.is_runtime_only || disabled || isHidden;
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: member.key, disabled: !canDrag || isLocked });
  const share = preview.steps.flatMap((step) => step.members).find((entry) => entry.key === member.key)?.share;
  const memberWeights = weights[member.key] ?? [];
  const canMoveUp = !disabled && !isHidden && (tierIndex > 0 || !isAlone);
  const canMoveDown = !disabled && !isHidden && (tierIndex < tierCount - 1 || !isAlone);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey || isLocked || event.target !== event.currentTarget) return;
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
      aria-keyshortcuts={isLocked ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
      aria-label={member.name}
      onKeyDown={handleKeyDown}
      className={clsx(
        styles['card'],
        canDrag && !isLocked && styles['card-draggable'],
        isDragging && styles['card-dragging'],
        landedKey === member.key && styles['card-landed'],
        (member.is_disabled || state === 'ineligible') && styles['card-muted'],
        isHidden && styles['card-hidden'],
      )}
      data-member={member.key}
      {...(canDrag && !isLocked ? listeners : {})}
    >
      <CardFace member={member}>
        {/* The card's own controls take their pointer for themselves rather than starting a drag. */}
        <span className={styles['card-end']} onPointerDown={(event) => event.stopPropagation()}>
          {member.is_disabled && <StatusLabel tone="neutral">{t('orch.state_disabled')}</StatusLabel>}
          {member.is_runtime_only && <StatusLabel tone="neutral" title={t('orch.state_runtime_hint')}>{t('orch.state_runtime')}</StatusLabel>}
          {state && STATE_KEYS[state] && <StatusLabel tone={state === 'blocked' ? 'warn' : 'neutral'}>{t(STATE_KEYS[state]!)}</StatusLabel>}
          {(state === 'serving' || state === 'standby') && (
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
              <ToolButton icon={<VerticalAlignTopOutlined />} label={t('orch.split_above')} disabled={disabled || isAlone} onClick={() => onSplit(member.key, 'above')} />
              <ToolButton icon={<VerticalAlignTopOutlined rotate={180} />} label={t('orch.split_below')} disabled={disabled || isAlone} onClick={() => onSplit(member.key, 'below')} />
            </ActionMenu>
          )}
        </span>
      </CardFace>
    </li>
  );
};

/** One weight per key; an empty field runs as CPA's default of 1. */
const WeightControl: React.FC<{
  member: RoutingMember;
  weights: (number | null)[];
  isLocked: boolean;
  onChange: (weights: (number | null)[]) => void;
}> = ({ member, weights, isLocked, onChange }) => {
  const t = useT();
  const total = weights.reduce<number>((sum, weight) => sum + (weight ?? 1), 0);
  const content = (
    <div className={styles['weight-editor']}>
      {weights.map((weight, index) => (
        <label key={member.weights[index]?.index ?? index} className={styles['weight-row']}>
          <span>{weights.length > 1 ? t('orch.weight_key', { n: index + 1 }) : t('orch.weight')}</span>
          <InputNumber
            size="small"
            min={0}
            max={1_000_000}
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
      <button type="button" className={styles['weight-chip']} aria-label={t('orch.weight_named', { name: member.name })}>
        ×{total}
      </button>
    </Popover>
  );
};
