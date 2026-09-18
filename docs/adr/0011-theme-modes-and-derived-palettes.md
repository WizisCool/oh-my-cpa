# ADR 0011: A theme mode chooses a palette, and every palette derives from nine authored tokens

- Status: Accepted
- Date: 2026-09-18

## Context

The console shipped six hand-tuned palettes - OMC Dark, OMC Light, Midnight, Porcelain, Forest,
Sandstone - and the header's theme control was a menu listing all six. A palette was thirty hex
values, and `docs/design.md` §5 argued explicitly that the control *had* to be a menu: "a toggle
answers only 'the other one', which stopped being the whole answer once the console carried six
registered themes".

Two requirements arrived together and neither is satisfiable in that model:

1. **Light and dark, with a palette behind each.** The control should answer the question an operator
   asks repeatedly - light or dark - while the palette each of those modes uses is a considered choice,
   made once.
2. **Operator-authored palettes.** This is what breaks the design. A form with thirty colour inputs is
   not a form; nobody authors a text ladder and a tooltip step and a chart track by hand, and a
   half-authored palette is an unreadable console that no code can catch, because the tokens are
   literals.

The existing palettes could not be reused as a derivation, and this was measured rather than assumed.
Fitting the six against a family of rules fails on nine of thirteen rules:

| Claimed relationship | Measured result |
| --- | --- |
| `hover` = `borderSoft` | holds in 1 of 6 (dark has them one step apart; every other palette differs) |
| `hoverInset` = `bg` | holds in 3 of 6 - all three dark palettes, none of the light ones |
| `heatmapQuiet` = `borderSoft` | fails on OMC Light (`#ececf0` vs `#ededf2`) |
| `heatmapZeroRecorded` = `seriesTrack` | fails on OMC Light and Midnight |
| `seriesTrack` = `border` | fails on OMC Dark and Midnight, which hold the two swapped |
| `cacheRateGreen` = `success` | fails on OMC Light (`#047857` vs `#059669`) |
| `accentHover` = a fixed lightness step | no constant step fits: the observed steps run −0.065 to −0.147 |
| `selected` = a blend toward the accent | no consistent fraction: the solved weights run −0.26 to +0.24 |

The six are a *family*, not a formula: they were picked by eye, and OMC Light and Midnight each break
the dark-mode conventions in several places. So a derivation for operator-authored palettes is not
something to read out of the existing palettes. It is something to design, calibrate, and state.

## Decision

**A theme is a mode, each mode holds one palette, and every palette is nine authored tokens with
seventeen derived ones.**

1. **The mode and the palette are separate settings.** `ThemePreference.mode` is `light`, `dark` or
   `system`; `palettes[mode]` names the palette that mode uses. Choosing a palette for the mode that is
   not in force *records* it and does not move the console - one click changes one setting.

2. **A palette is nine authored tokens, seventeen derived from them, and four mode constants.** The authored set is `bg`, `surface`,
   `elevated`, `fg`, `fg2`, `muted`, `meta`, `border`, `accent`. Everything else - the hover and
   selected fills, the border-soft step, the accent ladder, the tooltip fill, the heatmap stops, the
   cache-rate stops and the chart track - is derived by `derivePalette` in `web/src/theme/palette.ts`.
   The remaining four are `success`, `warn`, `danger` and the six-slot `series`, which come from
   `MODE_SEMANTICS[mode]`: they are semantics rather than palette, so a palette inherits its mode's set
   instead of deriving one (see the rejected alternative below). Those are the whole of a palette's
   thirty tokens.
   The six registered palettes are authored at nine tokens too and derived by the same function: there
   are no hand-tuned values left anywhere, which is what makes a custom palette *the same kind of
   thing* as a built-in one rather than a second, weaker path.

3. **The derivation is OKLCH, with four calibrated constants per mode.** Neutrals are perceptual blends
   (`hover = mix(bg → fg, 0.116 dark / 0.045 light)`, `borderSoft = mix(bg → border, 0.583 / 0.541)`,
   `hoverInset = bg in dark, mix(bg → fg, 0.05) in light`, `selected = mix(hover → accent, 0.075 /
   0.038)`); the accent ladder is a proportional lightness step (`0.831 / 0.855` for hover,
   `0.699 / 0.737` for active) followed by a solve. Two conventions survived fitting exactly and are
   kept: `tooltipBg = light ? fg : surface`, and `heatmapBusy = heatmapTipLink = accent`.

4. **The accent ladder solves its fills together rather than one at a time.** A fixed step can land a fill in the dead zone where
   neither white nor near-black clears 4.5:1 as a label - measured, a −0.075 step puts OMC Dark's label
   at 3.73:1 and Midnight's at 3.38:1 - and no label choice rescues that pair. So the step is the
   starting point and both fills keep moving until *one* ink clears the target (4.6:1, leaving hex
   rounding the room the asserted floor of 4.5:1 needs) on *both* of them. A single label is read in all
   three states, and solving the hover fill alone left Midnight's near-black label at 3.14:1 the moment
   its button was pressed; seven of eighteen authored accents broke the same way. The direction is chosen once per palette and
   used for all three states, and mirrors to *lightening* when the accent is too dark to deepen - an
   accent of `#000000` otherwise solves both its hover and pressed states to the same black, which is a
   filled control with no hover feedback.

5. **Contrast is reported per role and never blocks.** `fg`, `fg2` and `accent` answer to 4.5:1;
   `muted` to 3:1; `meta` to 2:1; the surface and border steps are layers with no text floor. The three
   floors are the steps the six palettes actually use (`muted` measures 3.87-4.93:1, `meta` 2.28-2.87:1),
   so a correct palette shows no warning - a single 4.5:1 threshold would leave every one of the six
   permanently flagged, and an indicator that is always lit is one nobody reads. `accentOn` is always
   computed and never editable. A colour an operator chose is not refused: the editor states the ratio
   and the console renders what they asked for.

6. **A custom palette has no name.** It is labelled `omc.palette_custom` - 「自定义」/「Custom」/「自訂」/
   「Tersuai」 - like every other control. The swatch beside the label says what it looks like, and a name
   would be a second label for one thing and the only string in the console that could not be translated.

7. **The palette is stored twice, and the browser's copy wins a conflict.** `omc-theme` holds the whole
   document in `localStorage` for the first frame and for the sign-in screen, where there is no session
   to read a preference with; the deployment's `ui_preferences` holds the same document under `omc_theme`
   so the choice outlives a browser. Any local change sets a `dirty` flag; on load, a dirty browser
   pushes and a clean one adopts.

8. **The header's control is a three-state button, and it names only itself.** It cycles light → dark →
   follow-the-system, with one icon per state. `docs/design.md` §5's "menus over toggles" argument is
   reversed for this control specifically, because the palettes moved to the settings page and the
   header's remaining question has three states and one consequence. The tooltip is the control's own
   name; it deliberately does not describe the next state. What carries the three states is the icon and
   the settings page's own row, which names all three in words.

## Named deviations from the hand-tuned values

Applying the derivation to the six registered palettes changes **59 of the 102** derived tokens (17 per
palette: OMC Dark 10, OMC Light 11, Midnight 8, Porcelain 8, Forest 11, Sandstone 11 - counted against
the previous commit's `themeConfig.ts` rather than remembered). Most are imperceptible (ΔL ≤ 0.03); these
are the ones a reader would notice, and they are accepted rather than tuned away, because tuning them away
would re-introduce hand-authored values into a derived set.

| Palette | Token | Was | Now | Effect |
| --- | --- | --- | --- | --- |
| OMC Dark | `selected` | `#242428` | `#2e2e37` | the selected state is visibly accent-tinted rather than a plain hover, which follows the four newer palettes |
| OMC Dark | `accentHover`, `accentActive` | `#0077b8`, `#005d8f` | `#0579bd`, `#025e94` | both filled-control steps move, so one ink clears the floor on the resting and the pressed state alike; white measures 4.69:1 and 6.93:1 |
| Midnight | `accentHover`, `accentActive` | `#1f6feb`, `#1158c7` | `#2475ca`, `#0259a7` | both fills deepen so that one ink clears the floor on both - the label stays white |
| Midnight | `seriesTrack` | `#21262d` | `#30363d` | the plot floor is the border step, which Midnight had swapped |
| Forest | `hover`, `rowHover` | `#213127` | `#232926` | a quieter hover, because the family constant follows the palette's own foreground |
| OMC Light | `borderSoft`, `hover`, `hoverInset` | `#ededf2`, `#ececf0`, `#ededf2` | `#f1f1f4`, `#f3f3f3`, `#f2f2f2` | the neutral steps of the light fallback follow the same rule as every other palette's |

## Alternatives considered

- **Keep the six palettes hand-tuned and derive only for custom palettes.** The smallest change, and it
  was the recommendation. Rejected by the operator: it leaves two kinds of palette in the code, so
  "change the hover rule" means changing a formula *and* six tables, and the next palette added is
  hand-tuned again.
- **Expose all thirty tokens.** Rejected: it makes the operator responsible for relationships the code
  can hold for them, and it is the version that can produce an unreadable console.
- **Expose only the accent.** Rejected as too little: it cannot change the page's own surfaces or the
  text ladder, which is most of what "I want this console to look like ours" means.
- **Block a save whose contrast is below the floor.** Rejected: an operator may legitimately want a
  low-contrast palette, the floor's applicability depends on the role, and a settings page that refuses
  to save is worse than one that states the number.
- **Derive the status hues and the categorical series from the accent.** Rejected: it would make green
  mean whatever the accent is, which is the one thing `docs/design.md` §1 forbids, and it would break
  ADR 0006's fixed series families. They stay per-mode constants.
- **Store the theme only in `localStorage`.** Rejected: the preference endpoint exists precisely so a
  choice survives a browser, and every other console setting already lives there.
- **Let the deployment's copy always win.** Rejected: the sign-in screen has no session, so a toggle
  made there would be silently undone by the first sign-in - the operator's most recent action is the
  one that should stand.

## Consequences

- The stylesheet's `:root` fallback is now a *mirror* of a derivation rather than an independent table,
  and `scripts/test-theme-presets.ts` asserts it token for token - including the two custom properties
  (`--elevated`, `--selected-inset`) that used to be set only at runtime.
- `docs/design.md` §2 and `DESIGN.md` print derived values. They are generated from the same formula and
  pinned by the same test, so a constant change fails the suite rather than silently diverging from the
  documentation.
- **Stated limitation: two browsers that both hold an unsaved change settle on whichever pushes last.**
  Neither `localStorage` nor `ui_preferences` carries a version to compare, and adding one would mean a
  conflict-resolution protocol for a setting that has no data behind it. `dirty` is cleared only once the
  deployment's copy agrees with this browser's, so a refused write is retried at the next load rather
  than lost.
- **Stated limitation: a refused write leaves the console showing the operator's palette while the
  deployment holds the previous one.** The failure is reported and the flag stays set, but the two are
  briefly out of step. Reconciling them silently would mean repainting the console under the operator's
  hands to a palette they did not choose.
- A custom palette is not shareable, exportable or importable. This is an explicit exclusion rather than
  an omission: a shared palette is a file format, a version, and an origin story, and none of that exists
  yet.
