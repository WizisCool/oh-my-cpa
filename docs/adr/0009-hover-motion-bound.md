# ADR 0009: Hover is bounded by the fast token rather than banned

- Status: Accepted
- Date: 2026-09-17

## Context

`docs/design.md` §7 rule 7 read: **"Hover is not an animation. A hover is the interface acknowledging
the pointer, so it paints on the frame the pointer arrives — never a transition on a hover colour."**
Its stated trap was concrete: Ant Design hangs menu-item hover, submenu expand and the sider collapse
off `motionDurationSlow`, whose default is 0.3s, and a nav that drags under the pointer feels broken.

Two things were true at the same time as that rule:

**The console's own hovers were already 50ms.** Roughly ten rules across seven files transition a
colour on hover — theme preset cards, OAuth cards, auth-file cards, quota rows, provider tab labels,
pricing chips and filter tabs, the leaderboard row, the request page's icon buttons. Most named
`var(--motion-fast, 50ms)`; a few used `0.15s` or `var(--motion-base)`. At 50ms a colour change is
three frames: below the threshold where a reader perceives motion, and above the threshold where a
hard switch reads as a repaint. So the rule's stated goal — "paints on the frame the pointer arrives"
— was already met by the code, while the code violated the rule as written.

**Enforcing the rule literally has a wide, invisible cost.** Deleting those transitions changes hover
behaviour on every page of the console, in all six themes, and buys nothing a reader can perceive. It
would also have been the first thing this repository did to hover styling in months, in a change whose
subject was the motion *budget* — the kind of opportunistic rewrite that makes a diff hard to review
and a regression hard to bisect.

The deciding evidence was the disparity between the rule and its target: the rule was written about a
0.3s nav drag, and the code it governed ran at 50ms. A ban and a three-frame softening are not the
same behaviour, and the rule was conflating them.

## Decision

1. **Rule 7 becomes a bound, not a prohibition.** A hover may transition colour, and must land within
   the `fast` token (50ms). It is rewritten in §7 with the bound stated, the antd trap kept as the
   reason the bound exists, and a pointer to this ADR.

2. **The bound is enforced, along with the rest of the budget.** `scripts/check-motion.mjs` fails a
   hover whose colour part does not name `var(--motion-fast)` exactly — a bare `50ms` is a number no
   document owns, and a fallback is never applied. `scripts/check-motion.test.mjs` exercises the rule
   in both directions.

3. **Two narrower prohibitions survive unchanged.** A hover may never transition a layout property
   (that is §7 rule 1, and it is now checked for every hover), and the one element that scales under
   the pointer may not fade its colour: the heatmap mark's probe still asserts that only `transform`
   animates there, because a colour fade would smear behind the scale it accompanies. The literal ban
   was never wrong for that element; it was too broad for the rest.

4. **The sites that exceeded the bound are corrected rather than grandfathered.** `0.15s` colour
   hovers on the request page's icon buttons and the leaderboard row become `var(--motion-fast)`, and
   the OAuth card's `var(--motion-base)` border becomes `fast` — the same three-frame softening every
   other hover in the console already had.

5. **`transition: all` is rejected outright.** It is not a hover question but it surfaced with them:
   `all` animates every property a change touches, including the layout properties rule 1 forbids, and
   it makes the intent of a transition unreadable. Five sites were enumerated into the properties they
   actually change, and one — a provider icon button whose style is entirely static — had a transition
   that animated nothing and was removed.

## Consequences

### Positive

- The budget now covers what the console actually does. Before this, a reader could not tell whether
  the 50ms hovers were compliant or unnoticed violations, which is the state in which a rule stops
  being consulted at all.
- Hover behaviour is unchanged on every page. The one visible change is that a few hovers became
  slightly faster, moving toward the bound rather than away from it.
- The bound is in the checker, so the next hover added is judged by it rather than by memory.

### Trade-offs

- **§7 rule 7 is weaker than it was.** It went from a flat prohibition to a duration bound, and a
  reader who wants "no hover transitions at all" no longer finds that rule. That is the honest
  description of the console's behaviour, but it is a relaxation of a documented constraint.
- **Three frames of colour fading is a judgement, not a measurement.** The claim is that 50ms is
  imperceptible as motion; nobody sat readers in front of it, and a future decision to ban hover
  transitions outright would have to be made on taste rather than on this ADR's evidence.
- **The exceptions table grows.** Layout animations that a disclosure needs are named waivers now, and
  a budget with waivers is more work to read than a budget without them. The mitigation is that each
  waiver carries a reason and an unused waiver fails the check.
- **The checker is textual.** It reads `.css` and inline `transition:` strings, so a duration
  assembled at runtime is invisible to it, and it cannot associate a rule restated under a different
  selector with its motion. Both limits are stated in the checker's own header rather than left for a
  reader to discover.

## Alternatives considered

- **Enforce rule 7 literally and delete the hover transitions.** The most faithful reading, and it was
  the first proposal. Rejected: it rewrites hover behaviour across every page and all six themes to
  remove an animation three frames long, in a change about the budget — a cost with no measurable
  benefit, and a large diff that hides the corrections that do matter.
- **Keep the rule and leave the code as it is.** Rejected: that is the state the drift audit found, and
  the reason the audit exists. A rule the code ignores is worse than a rule that is wrong, because it
  teaches readers to skip the section.
- **Amend only the docs and add no checker.** Rejected: §7 had already drifted twice (the stylesheet's
  tokens, and this), and both times the drift was invisible because nothing read the rule. A bound that
  is not enforced is a bound that will be exceeded.
- **Bound hover to `base` (100ms) instead.** Rejected: at 100ms a colour fade starts to read as
  movement under the pointer, which is the drag the rule was written about.
- **Require `prefers-reduced-motion` to kill hover transitions too.** Rejected as over-reach at this
  duration: three frames of colour is not the motion the preference is about, and the console already
  kills the hovers that move (the heatmap mark's scale) rather than the ones that tint. The checker
  enforces that split for keyframe animations, which are the real intrusions.