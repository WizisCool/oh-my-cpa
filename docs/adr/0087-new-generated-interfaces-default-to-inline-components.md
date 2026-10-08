# ADR 0087: New generated interfaces default to inline components

- Status: Accepted
- Date: 2026-10-08
- Amends: [ADR 0082](0082-a-display-is-drawn-where-the-model-calls-it.md) for new-call framing and
  [ADR 0085](0085-a-generated-ui-is-composed-from-components-and-drawn-as-it-is-written.md) for
  the height bound and layout contract.

## Context

Generated interfaces are parts of an answer, not only standalone chart artifacts. A filter,
calculator or workflow explorer should sit beside the text that explains it without adding
another card, heading and scrolling viewport. The earlier 1600px height bound also forced
ordinary dashboards to scroll inside the conversation, narrowing charts on classic scrollbars.
Existing conversations must keep the presentation with which they were saved.

## Decision

New `render_ui` calls default to `frame: none`. The server stores that choice explicitly;
`frame: card` remains stored as absence, preserving the interpretation of older views.
Drafts use the same default for `render_ui`; legacy display drafts retain card framing.
Models are instructed to write framing before markup, choose task-shaped local controls,
compose from the offline component kit and use natural, responsive document layout.

Content height grows and shrinks within 48px–16384px, matching the saved-image height ceiling.
Resize and mutation observations coalesce into one animation-frame measurement, excluding
viewport height so a previously taller component can shrink after filtering. A measurement a
layout change alone produced and that repeats the last overflow is not sent: content sized from the
frame itself (`min-height:100vh`, `height:100%`) is taller with every frame it is given, so
reporting it would grow the frame into blank space without end. A content mutation always reports,
so a component that is still being written keeps growing. Above the cap, content remains
scrollable rather than disappearing. Embedded components share the console's
surface and control radius values in live views, streamed previews and exports.

A draft renders partial markup with a fresh script nonce granted only to the host bootstrap;
model scripts, inline event handlers and JavaScript URLs cannot execute during streaming.
The completed component activates its scripts only in the existing opaque-origin, network-blocked sandbox. Local
interactions use frozen content. `OMC.compose` offers a reviewed message draft for new reads or
writes; it neither sends the message nor bypasses capability approval.

## Consequences

The model can compose multiple complementary components among answer paragraphs while keeping
simple answers textual. Historical framing and the existing security boundary remain stable.
A taller bound permits more layout allocation from untrusted frame messages, but that allocation
is finite and validated. Script-dependent controls become active only when generation completes;
progressive markup is not a general-purpose incremental script compiler.
