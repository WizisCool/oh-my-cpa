# ADR 0076: The Agent has its own shell and names its model in the composer

- Status: Accepted
- Date: 2026-10-08
- Narrows [ADR 0041](0041-agent-runs-speak-ag-ui-and-render-with-assistant-ui.md)'s
  shared workspace: the transcript, the composer and the message views stay shared
  with the Playground; the frame around them no longer is.

## Context

The Agent was drawn in the frame built for the Playground: a ruled head with a
title, a key select and a model select; a resizable side panel open by default with
three tabs; a conversation in what was left. That frame is right for the Playground,
which is a test bench - its parameters and diagnostics are the point, and they
belong beside the transcript at all times.

For the Agent the same frame said the wrong thing. The page read as a harness around
a chat rather than as an assistant: two selects before any question, a registry
listing occupying a third of the screen, an empty transcript above a box at the
bottom. None of that is what an operator came for, and the capability directory -
reference material - outweighed the conversation it documents.

## Decision

**The Agent page is the conversation.** It has no page head and no panel at rest.
`AgentPage` lays out its own shell; `WorkspaceLayout` remains the Playground's.

**An empty conversation gathers mid-page.** The wordmark, one question as a title,
one paragraph, the composer and four starting questions sit together a little above
the centre. Once a message is sent the composer takes its place at the bottom of the
reading column, under the transcript.

**The model is chosen where the message is written.** The composer's foot ends with
a chip naming the model, beside the reasoning-effort chip and send. The chip opens a list of the key's models,
each led by its maker's mark, with the client key at the head of the list - key and
model remain one decision, but only the model is always in view. A list longer than
eight is searchable. With no target chosen the chip is the one control drawn in the
warning hue, and send says why it is blocked.

**Reasoning effort is its own chip, and its levels are a slider.** Effort changes
more often than the model and independently of it, so it is not folded into the model
list. Its chip names the level in force and opens a scale between two ends an
operator can weigh - faster, smarter - with a stop per named level and the thumb on
the one in force. "Use model default" leaves the field out of the request; it is not
a point on the scale, so it is a separate choice under the track, and the track then
has no thumb.

**The composer's frame holds what a message is made of and sent with, and nothing
else.** Its foot has four controls: a round `+` that attaches, the effort chip, the
model chip, and one round ink-filled button that is send (an up arrow) or stop (a square). Nothing
that only reports sits in the frame: the context ring is under it, on the line that
states the data boundary. `/` and `@` have no buttons; the placeholder names them.

**What sits beside the conversation is asked for.** One Drawer on the right shows
the capability directory or the connection guide - opened by the two icon actions
at the page's top edge, or by `/capabilities` and `/connect`. A call's own details
open in the conversation ([ADR 0084](0084-calls-are-a-timeline-of-disclosures-in-the-answer.md)). It closes with Escape, its close control or the platform's Back gesture,
at every viewport width.

**Page actions float together at the conversation's top trailing corner.** "New
conversation" leads them, labelled, once there is a conversation to replace; export,
the directory and the connection guide follow as icons after a short rule. One
cluster is one place to look: alone at the leading edge, starting over sat apart
from every other action of the page and read as part of the transcript. They sit
above the transcript's padding rather than in a ruled row.

## Consequences

- The Agent and the Playground no longer look alike at the frame level. Changes to
  `WorkspaceLayout` do not reach the Agent; changes to the shared transcript,
  composer, Markdown and reasoning views still reach both.
- The capability directory is one click away instead of always visible. An operator
  who wants to read what the agent may do before asking has to open it; the empty
  state's paragraph says the agent asks before changing anything.
- The side panel's width preference and splitter no longer apply to the Agent. A
  Drawer covers part of the conversation while open, which a resizable panel did
  not.
- The client key is one click further from view than the model. A message's key is
  still stated in the conversation's stored target and restored with it.
- `TargetChip` lives in the shared workspace components and can serve the Playground
  later; the Playground keeps `TargetPicker` in its head for now.
