/**
 * The physics behind a panel's resizable leading edge: the edge follows the pointer inside its
 * bounds, gives at most a short rubber band past them and springs back on release. The grip is the
 * panel's own hairline swelling where the pointer is: one quadratic curve drawn over the border,
 * fading into it at both ends, that bows the way the edge is moving and draws out long and thin
 * when pulled past a bound. Nothing is laid on top of the edge; the edge itself gives.
 *
 * It knows nothing of React or of the drawer it serves. The host owns the width - where it lives,
 * how it is clamped in CSS and where it is saved - and the engine only drives a live width while
 * the edge is in motion, then hands the settled one back. Everything is in CSS pixels of the
 * panel's width; the edge's on-screen x only matters for the grip's lean, which is the negation.
 */

/**
 * The swelling's resting shape and how far each gesture reshapes it, in SVG user units (px). Its
 * ends fade to nothing, so the visible swell is roughly the middle half of `length`.
 */
const GRIP = {
  /** Centre of the 24×200 view box: the border runs through x = 12. */
  centerX: 12,
  centerY: 100,
  restLength: 84,
  restStroke: 4,
  /**
   * The length it grows from as it appears and shrinks back to as it goes: a short swell already,
   * so appearing reads as the edge filling out rather than as something fading in from nowhere.
   */
  hiddenLength: 40,
  /** Added to the length, and taken from the stroke, at full drag speed. */
  dragLength: 32,
  dragStroke: 1,
  /** Added again, and taken again, at full overshoot. */
  overLength: 40,
  overStroke: 1,
  /** Peak sideways bow of the curve's middle while dragging. */
  bend: 4,
  /** The whole curve's drift off the border: small, so its ends stay on the hairline. */
  lean: 1.5,
  overLean: 1.5,
} as const;
/** How close to the panel's top and bottom the swell may sit: clear of the rounded corners. */
const GRIP_INSET = 28;

/** Rubber band past a bound: at most this many pixels, approached along this decay length. */
const RUBBER_MAX = 15;
const RUBBER_DECAY = 35;
/** Overshoot (px) at which the grip has fully become the long thin line. */
const OVERSHOOT_FULL = 80;
/** Pointer speed (px/s) that counts as a full-strength drag for the grip's bend. */
const SPEED_FULL = 60;
const SPEED_LIMIT = 2200;
/** A pointer that has not moved for this long is treated as still. */
const SPEED_STALE_MS = 70;
/** A short grace after the pointer leaves, so a hand drifting off the edge and back keeps it. */
const HIDE_DELAY_MS = 240;
/** A press that moves less than this and lets go within the time is a click, not a drag. */
const CLICK_SLOP_PX = 3;
const CLICK_MS = 400;
/**
 * The swell is the hairline's own ink firmed toward the muted ink: at rest most of the way, under a
 * drag all of it. Its gradient fades it to transparent at both ends, onto the border it grows from.
 */
const INK_MUTED_REST = 70;
const INK_MUTED_STRAINED = 100;
/**
 * Hover intent. The edge is crossed on the way to the page, to the mask and back into the panel,
 * and the grip should not flash at every crossing: it appears once the pointer has slowed to a
 * near stop inside the zone for this long, with no button held. The resize cursor waits for the
 * same moment (`data-armed`), so the cursor and the grip always answer together.
 */
const HOVER_DWELL_MS = 90;
/** Faster than this (px/ms) is passing through, which restarts the dwell. */
const HOVER_PASSING_SPEED = 0.35;

/** Nearly critically damped: the released edge is home in about a quarter second, without a wobble. */
const POSITION_SPRING = { stiffness: 600, damping: 44 } as const;
const GRIP_SPRING = { stiffness: 680, damping: 34 } as const;
const GRIP_EASE_RATE = 32;
/** Appearing keeps pace with the cursor change: most of the way in about 80ms. */
const REVEAL_EASE_RATE = 28;
const SUBSTEPS = 4;

export interface ElasticEdgeBounds {
  min: number;
  max: number;
}

export interface ElasticEdgeHost {
  /** The focusable separator that is also the pointer hit zone. */
  handle: HTMLElement;
  /** The swell's curve, and the gradient along it that fades its ends into the border. */
  ink: SVGPathElement;
  gradient: SVGLinearGradientElement;
  glyph: SVGSVGElement;
  /** The panel's rendered width, read whenever the edge starts from rest. */
  readWidth(): number;
  /** The panel's right edge in viewport coordinates; the edge being dragged is `right - width`. */
  readRight(): number;
  bounds(): ElasticEdgeBounds;
  /** The width the panel takes when nothing is saved. */
  defaultWidth(): number;
  /** Drives the panel while the edge moves; `null` hands the width back to the host's own value. */
  setLiveWidth(width: number | null): void;
  /** A settled, deliberate width: persist it. */
  commit(width: number): void;
  /** A click on the edge: forget any saved width. */
  reset(): void;
  describe(width: number): string;
  announce(text: string): void;
  isReducedMotion(): boolean;
}

interface Drag {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  startedAt: number;
  hasMoved: boolean;
  /** Pointer distance from the right edge minus the panel width at grab time. */
  grab: number;
  right: number;
  startTarget: number;
  bounds: ElasticEdgeBounds;
  rawWidth: number;
  lastX: number;
  lastMoveAt: number;
  /** Signed x speed of the pointer, px/s. */
  speed: number;
  /** How far past a bound the pointer has pulled, signed in screen x. */
  overshootX: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class ElasticEdge {
  private readonly host: ElasticEdgeHost;
  private width = 0;
  private velocity = 0;
  private target = 0;
  private bendNow = 0;
  private bendVelocity = 0;
  private leanNow = 0;
  private leanVelocity = 0;
  private length: number = GRIP.hiddenLength;
  private stroke = 0;
  private reveal = 0;
  /** Where along the edge the swell sits, from the hit zone's top: it follows the pointer. */
  private gripY = 0;
  private gripYTarget = 0;
  private drag: Drag | null = null;
  private isHovered = false;
  private isFocused = false;
  private isShown = false;
  private isMoving = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private dwellTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHover: { x: number; y: number; at: number } | undefined;
  private frame: number | undefined;
  private lastFrameAt: number | undefined;
  private lastInk = '';

  constructor(host: ElasticEdgeHost) {
    this.host = host;
    const { handle } = host;
    handle.addEventListener('pointerenter', this.onPointerEnter);
    handle.addEventListener('pointerleave', this.onPointerLeave);
    handle.addEventListener('pointerdown', this.onPointerDown);
    handle.addEventListener('pointermove', this.onPointerMove);
    handle.addEventListener('pointerup', this.onPointerUp);
    handle.addEventListener('pointercancel', this.onPointerCancel);
    handle.addEventListener('lostpointercapture', this.onLostCapture);
    handle.addEventListener('keydown', this.onKeyDown);
    handle.addEventListener('focus', this.onFocus);
    handle.addEventListener('blur', this.onBlur);
    this.syncAria(host.readWidth());
    this.paint(0);
  }

  destroy(): void {
    const { handle } = this.host;
    handle.removeEventListener('pointerenter', this.onPointerEnter);
    handle.removeEventListener('pointerleave', this.onPointerLeave);
    handle.removeEventListener('pointerdown', this.onPointerDown);
    handle.removeEventListener('pointermove', this.onPointerMove);
    handle.removeEventListener('pointerup', this.onPointerUp);
    handle.removeEventListener('pointercancel', this.onPointerCancel);
    handle.removeEventListener('lostpointercapture', this.onLostCapture);
    handle.removeEventListener('keydown', this.onKeyDown);
    handle.removeEventListener('focus', this.onFocus);
    handle.removeEventListener('blur', this.onBlur);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    if (this.drag && handle.hasPointerCapture?.(this.drag.pointerId)) handle.releasePointerCapture(this.drag.pointerId);
    this.drag = null;
    clearTimeout(this.hideTimer);
    clearTimeout(this.dwellTimer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (this.isMoving) this.host.setLiveWidth(null);
  }

  // ── visibility ────────────────────────────────────────────────────────────

  private updateShown(): void {
    const wantsShown = this.isHovered || this.isFocused || this.drag !== null;
    if (wantsShown) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
      if (!this.isShown) {
        this.isShown = true;
        this.host.handle.dataset.armed = 'true';
        // A swell that has faded out surfaces where it is wanted rather than sliding there.
        if (this.reveal < 0.05) this.gripY = this.gripYTarget;
        this.wake();
      }
      return;
    }
    if (!this.isShown || this.hideTimer !== undefined) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      this.isShown = false;
      delete this.host.handle.dataset.armed;
      this.wake();
    }, HIDE_DELAY_MS);
  }

  private onPointerEnter = (event: PointerEvent) => {
    // Entering alone is not intent - the panel may have slid in under a resting cursor - so the
    // dwell starts with the first movement inside the zone.
    this.lastHover = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  };

  /** Points the swell at the pointer's height along the edge. */
  private aimAt(clientY: number): void {
    this.gripYTarget = clientY - this.host.handle.getBoundingClientRect().top;
    if (this.isShown) this.wake();
  }

  private trackHover(event: PointerEvent): void {
    if (event.pointerType !== 'mouse') return;
    this.aimAt(event.clientY);
    if (this.isHovered) return;
    // A held button is a selection or another drag sweeping past, not a visit to the edge.
    if (event.buttons !== 0) { this.cancelDwell(); return; }
    const last = this.lastHover;
    this.lastHover = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    const elapsed = last ? Math.max(event.timeStamp - last.at, 1) : 1;
    const speed = last ? Math.hypot(event.clientX - last.x, event.clientY - last.y) / elapsed : Infinity;
    if (speed > HOVER_PASSING_SPEED) this.cancelDwell();
    if (this.dwellTimer !== undefined) return;
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = undefined;
      this.isHovered = true;
      this.updateShown();
    }, HOVER_DWELL_MS);
  }

  private cancelDwell(): void {
    clearTimeout(this.dwellTimer);
    this.dwellTimer = undefined;
  }

  private onPointerLeave = (event: PointerEvent) => {
    if (this.drag?.pointerId === event.pointerId) return;
    this.cancelDwell();
    this.lastHover = undefined;
    this.isHovered = false;
    this.updateShown();
  };

  private onFocus = () => {
    this.isFocused = true;
    if (!this.isHovered && !this.drag) this.gripYTarget = this.host.handle.getBoundingClientRect().height / 2;
    this.syncAria(this.restingWidth());
    this.updateShown();
  };

  private onBlur = () => {
    this.isFocused = false;
    this.updateShown();
  };

  // ── pointer ───────────────────────────────────────────────────────────────

  /** The width the edge starts from: where it is drawn if still springing, else where it rests. */
  private restingWidth(): number {
    return this.isMoving ? this.width : this.host.readWidth();
  }

  private beginMotion(): void {
    if (this.isMoving) return;
    this.width = this.host.readWidth();
    this.target = this.width;
    this.velocity = 0;
    this.isMoving = true;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.drag) return;
    // Keep text from being selected and the page from scrolling under the gesture; focus stays
    // where it was, so only a keyboard visit draws the focus ring.
    event.preventDefault();
    this.cancelDwell();
    this.aimAt(event.clientY);
    if (!this.isShown && this.reveal < 0.05) this.gripY = this.gripYTarget;
    this.beginMotion();
    const right = this.host.readRight();
    this.drag = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      hasMoved: false,
      grab: right - event.clientX - this.width,
      right,
      startTarget: this.target,
      bounds: this.host.bounds(),
      rawWidth: this.width,
      lastX: event.clientX,
      lastMoveAt: event.timeStamp,
      speed: 0,
      overshootX: 0,
    };
    this.velocity = 0;
    this.host.handle.setPointerCapture?.(event.pointerId);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
    this.host.handle.dataset.dragging = 'true';
    this.updateShown();
    this.wake();
  };

  private onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag) { this.trackHover(event); return; }
    if (drag.pointerId !== event.pointerId) return;
    this.gripYTarget = event.clientY - this.host.handle.getBoundingClientRect().top;
    if (!drag.hasMoved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CLICK_SLOP_PX) return;
    drag.hasMoved = true;
    const rawWidth = drag.right - event.clientX - drag.grab;
    const seconds = Math.max((event.timeStamp - drag.lastMoveAt) / 1000, 0.008);
    drag.speed = clamp((event.clientX - drag.lastX) / seconds, -SPEED_LIMIT, SPEED_LIMIT);
    drag.lastX = event.clientX;
    drag.lastMoveAt = event.timeStamp;
    drag.rawWidth = rawWidth;
    const target = clamp(rawWidth, drag.bounds.min, drag.bounds.max);
    const excess = rawWidth - target;
    this.target = target;
    drag.overshootX = -excess;
    this.width = this.host.isReducedMotion()
      ? target
      : target + Math.sign(excess) * RUBBER_MAX * (1 - Math.exp(-Math.abs(excess) / RUBBER_DECAY));
    this.wake();
  };

  private finishDrag(event: PointerEvent | null, isCancelled: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    delete this.host.handle.dataset.dragging;
    const { handle } = this.host;
    if (handle.hasPointerCapture?.(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    // A captured pointer released outside the hit zone must not leave a hover behind.
    if (event && drag.pointerType === 'mouse') {
      const rect = handle.getBoundingClientRect();
      this.isHovered = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    } else {
      this.isHovered = false;
    }
    this.velocity = 0;
    const isClick = !isCancelled && !drag.hasMoved && event !== null && event.timeStamp - drag.startedAt <= CLICK_MS;
    if (isCancelled) {
      this.target = drag.startTarget;
    } else if (isClick) {
      this.resetToDefault();
    } else if (Math.round(this.target) !== Math.round(drag.startTarget)) {
      this.settleTarget(this.target);
    }
    if (this.host.isReducedMotion()) this.width = this.target;
    this.updateShown();
    this.wake();
  }

  private onPointerUp = (event: PointerEvent) => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag(event, false);
  };

  private onPointerCancel = (event: PointerEvent) => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag(null, true);
  };

  private onLostCapture = (event: PointerEvent) => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag(event, false);
  };

  /** Escape during a drag puts the edge back where the press found it, and does not close the panel. */
  private onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishDrag(null, true);
  };

  // ── keyboard and reset ────────────────────────────────────────────────────

  private onKeyDown = (event: KeyboardEvent) => {
    if (this.drag) return;
    const bounds = this.host.bounds();
    const step = event.shiftKey ? 96 : 24;
    const from = this.isMoving ? this.target : this.host.readWidth();
    let next: number;
    switch (event.key) {
      // The panel opens from the right, so moving its edge left widens it.
      case 'ArrowLeft': next = from + step; break;
      case 'ArrowRight': next = from - step; break;
      case 'Home': next = bounds.max; break;
      case 'End': next = bounds.min; break;
      // The keyboard's click: back to the opening width.
      case 'Enter':
        event.preventDefault();
        this.resetToDefault();
        return;
      default: return;
    }
    event.preventDefault();
    this.moveTo(clamp(next, bounds.min, bounds.max));
    this.settleTarget(this.target);
  };

  private resetToDefault(): void {
    const bounds = this.host.bounds();
    this.moveTo(clamp(this.host.defaultWidth(), bounds.min, bounds.max));
    this.host.reset();
    this.announceWidth(this.target);
  }

  private moveTo(width: number): void {
    this.beginMotion();
    this.target = width;
    if (this.host.isReducedMotion()) { this.width = width; this.velocity = 0; }
    this.wake();
  }

  private settleTarget(width: number): void {
    const rounded = Math.round(width);
    this.target = rounded;
    this.host.commit(rounded);
    this.announceWidth(rounded);
  }

  private announceWidth(width: number): void {
    this.syncAria(width);
    this.host.announce(this.host.describe(width));
  }

  private syncAria(width: number): void {
    const { handle } = this.host;
    const bounds = this.host.bounds();
    handle.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuetext', this.host.describe(Math.round(width)));
  }

  // ── frame loop ────────────────────────────────────────────────────────────

  private wake(): void {
    if (this.frame !== undefined) return;
    this.lastFrameAt = undefined;
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = undefined;
    const dt = this.lastFrameAt === undefined ? 1 / 60 : Math.min((now - this.lastFrameAt) / 1000, 1 / 30);
    this.lastFrameAt = now;
    const isSettled = this.host.isReducedMotion() ? this.stepReduced() : this.step(now, dt);
    if (isSettled) {
      this.lastFrameAt = undefined;
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  /** One frame of motion; true once everything has come to rest and the loop can stop. */
  private step(now: number, dt: number): boolean {
    const drag = this.drag;
    const speed = drag && now - drag.lastMoveAt <= SPEED_STALE_MS ? drag.speed : 0;
    const direction = clamp(speed / SPEED_FULL, -1, 1);
    const overshootX = drag?.overshootX ?? 0;
    const over = clamp(Math.abs(overshootX) / OVERSHOOT_FULL, 0, 1);
    const strain = Math.max(Math.abs(direction) * (1 - over), over);
    const bendTarget = GRIP.bend * direction * (1 - over);
    const leanTarget = GRIP.lean * direction * (1 - over) + GRIP.overLean * Math.sign(overshootX) * over;
    const revealTarget = this.isShown ? 1 : 0;
    const shapedLength = GRIP.restLength + GRIP.dragLength * strain + GRIP.overLength * over;
    const lengthTarget = GRIP.hiddenLength + (shapedLength - GRIP.hiddenLength) * revealTarget;
    const strokeTarget = (GRIP.restStroke - GRIP.dragStroke * strain - GRIP.overStroke * over) * revealTarget;

    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i += 1) {
      if (!drag) {
        this.velocity += ((this.target - this.width) * POSITION_SPRING.stiffness - this.velocity * POSITION_SPRING.damping) * h;
        this.width += this.velocity * h;
      }
      this.bendVelocity += ((bendTarget - this.bendNow) * GRIP_SPRING.stiffness - this.bendVelocity * GRIP_SPRING.damping) * h;
      this.bendNow += this.bendVelocity * h;
      this.leanVelocity += ((leanTarget - this.leanNow) * GRIP_SPRING.stiffness - this.leanVelocity * GRIP_SPRING.damping) * h;
      this.leanNow += this.leanVelocity * h;
    }
    const ease = 1 - Math.exp(-GRIP_EASE_RATE * dt);
    this.stroke += (strokeTarget - this.stroke) * ease;
    this.length += (lengthTarget - this.length) * ease;
    this.reveal += (revealTarget - this.reveal) * (1 - Math.exp(-REVEAL_EASE_RATE * dt));
    this.gripY += (this.gripYTarget - this.gripY) * ease;

    const isSettled = !drag
      && Math.abs(this.target - this.width) < 0.01 && Math.abs(this.velocity) < 0.05
      && Math.abs(bendTarget - this.bendNow) < 0.01 && Math.abs(this.bendVelocity) < 0.03
      && Math.abs(leanTarget - this.leanNow) < 0.01 && Math.abs(this.leanVelocity) < 0.03
      && Math.abs(strokeTarget - this.stroke) < 0.01 && Math.abs(lengthTarget - this.length) < 0.01
      && Math.abs(revealTarget - this.reveal) < 0.001 && Math.abs(this.gripYTarget - this.gripY) < 0.1;
    if (isSettled) {
      this.snapToRest(revealTarget);
      return true;
    }
    if (this.isMoving) this.host.setLiveWidth(this.width);
    this.paint(strain);
    return false;
  }

  /** Reduced motion: the edge goes straight where it is put and the grip stays a straight capsule. */
  private stepReduced(): boolean {
    if (!this.drag) this.width = this.target;
    this.bendNow = 0;
    this.leanNow = 0;
    this.reveal = this.isShown ? 1 : 0;
    if (this.drag) {
      this.length = GRIP.restLength;
      this.stroke = GRIP.restStroke;
      this.gripY = this.gripYTarget;
      this.host.setLiveWidth(this.width);
      this.paint(0);
      // A drag waits for the next move rather than spinning frames while the pointer is still.
      return true;
    }
    this.snapToRest(this.reveal);
    return true;
  }

  private snapToRest(reveal: number): void {
    this.width = this.target;
    this.gripY = this.gripYTarget;
    this.velocity = 0;
    this.bendNow = 0;
    this.bendVelocity = 0;
    this.leanNow = 0;
    this.leanVelocity = 0;
    this.length = reveal > 0 ? GRIP.restLength : GRIP.hiddenLength;
    this.reveal = reveal;
    this.stroke = GRIP.restStroke * reveal;
    if (this.isMoving) {
      this.isMoving = false;
      // The host's own width already holds the committed value, so dropping the live width is seamless.
      this.host.setLiveWidth(null);
    }
    this.paint(0);
  }

  private paint(strain: number): void {
    const { ink, gradient, glyph, handle } = this.host;
    const x = GRIP.centerX + this.leanNow;
    const half = this.length / 2;
    const top = GRIP.centerY - half;
    const bottom = GRIP.centerY + half;
    const d = `M${x.toFixed(2)} ${top.toFixed(2)}Q${(x + 2 * this.bendNow).toFixed(2)} ${GRIP.centerY} ${x.toFixed(2)} ${bottom.toFixed(2)}`;
    ink.setAttribute('d', d);
    ink.style.strokeWidth = `${Math.max(this.stroke, 0)}`;
    gradient.setAttribute('y1', top.toFixed(2));
    gradient.setAttribute('y2', bottom.toFixed(2));
    const height = handle.clientHeight;
    const y = height > 2 * (GRIP_INSET + half) ? clamp(this.gripY, GRIP_INSET + half, height - GRIP_INSET - half) : height / 2;
    glyph.style.transform = `translate(-50%, ${(y - GRIP.centerY).toFixed(2)}px)`;
    glyph.style.opacity = this.reveal.toFixed(3);
    const muted = `${Math.round(INK_MUTED_REST + (INK_MUTED_STRAINED - INK_MUTED_REST) * strain)}`;
    if (muted !== this.lastInk) {
      this.lastInk = muted;
      glyph.style.color = `color-mix(in oklab, var(--muted) ${muted}%, var(--border))`;
    }
  }
}
