# ADR 0045: Feedback surfaces are chosen by what the message describes

- Status: Accepted
- Date: 2026-09-30

## Context

The console reported outcomes and failures through four unrelated mechanisms: antd's `message`
API for most action results, raw antd `Alert` banners placed ad hoc inside pages, information-only
`modal.warning` / `modal.info` dialogs for batch failures, and an in-page operation report on the
credential workspace for a quota refresh that had failing targets. Which one a page used depended
on who wrote it, not on what was being said. The effects were visible:

- The same outcome could appear twice. A refused configuration save raised a message and also left
  an error banner above the editor.
- An action's result that landed as an in-page banner pushed the content it described down the page
  and stayed there after the operator had read it; the quota report is the clearest case.
- A failed read of one panel was a banner without a way to retry, so repairing one chart meant
  reloading the page.
- Batch failures interrupted with a modal the operator had to dismiss before doing anything else.
- `message` holds one line, so a per-target reason (the only useful part of a batch report) could
  not be carried by it, which is why the in-page report existed at all.

## Decision

The surface is chosen by what the message describes, not by how serious it is, and every surface
lives in `web/src/components/feedback/`:

| The message describes | Surface |
| --- | --- |
| The outcome of something the operator just did | a toast, `useToast()` |
| A region that could not be read | `LoadFailure` in that region's place, with Retry |
| A condition that holds while the region is on screen | `Notice`, where it applies |
| A refusal of the input in front of the operator | `Notice` (or the form's field error), beside that input |

- The toast is built on antd's `notification`, not `message`, because a notification can carry a
  second line, a list and actions. A batch outcome with per-target reasons is a *report toast*: the
  reasons are listed under group headings and the toast stays until it is closed. This replaces the
  in-page quota report and the information-only failure dialogs.
- One outcome reaches one surface. `modal.confirm` still asks before an action; nothing opens a
  dialog to report after one.
- Toast content never changes height after it opens. antd positions notifications from heights it
  measures on arrival, so an expandable group would slide under the toast below it; a long group of
  context is summarised one line per reason instead.
- `pnpm check:feedback` refuses antd `Alert`, `message`, `notification` and information-only
  `modal.*` dialogs anywhere in `web/src` outside the feedback module.

## Consequences

- A quota refresh no longer moves the credential list: every outcome, including one with failing
  targets, is a toast. A report the operator has not closed is replaced, not stacked, by the next
  refresh because it reuses one notification key.
- Every failed read in the console offers Retry for that region alone.
- Acceptance probes assert on `.omc-toast` rather than antd's message classes, and a probe that
  continues after a report toast must close it, because it stays.
- A new page cannot reintroduce a raw banner or a second notification API without the static gate
  failing; the one sanctioned place to extend feedback is `components/feedback`.
- A report toast is limited to what fits a floating panel (its list scrolls within a capped height).
  A result that needs sorting, filtering or export would need its own page region, and would be a new
  decision.
