# ADR 0088: A conversation chooses its inference endpoint in the composer

- Status: Accepted
- Date: 2026-10-09
- Extends [ADR 0022](0022-session-authenticated-model-playground.md) and
  [ADR 0041](0041-agent-runs-speak-ag-ui-and-render-with-assistant-ui.md): the Playground and the
  Agent still reach CPA only through the gateway client and fixed paths; there are now three.
- Completes what [ADR 0076](0076-the-agent-has-its-own-shell-and-names-its-model-in-the-composer.md)
  left open: `TargetChip` now serves the Playground, and `TargetPicker` is removed.

## Context

CPA serves a client key on three inference endpoints: Chat Completions
(`/v1/chat/completions`), Responses (`/v1/responses`) and Messages (`/v1/messages`). Each
is what a different family of clients speaks, and CPA translates each to whichever provider
routes the model. The Playground and the Agent sent every conversation to Chat Completions, so
an operator debugging a client that speaks Responses or Messages could not reproduce that
client's path through CPA - the translation they needed to test was never exercised - and a
model that behaves better on its native endpoint could not be driven through it.

Separately, the Playground chose its key and model in two selects in the page head and its
reasoning effort in a free-text field of the side panel, while the Agent chose all three on
chips in the composer. Two pages asked the same question - what is the next message sent
with - in two places and two idioms.

## Decision

**A conversation is sent to one of CPA's three endpoints, chosen by name.**
A Playground request and an Agent run each carry `endpoint`: `chat` (the default, and what an absent field means),
`responses` or `messages`. It is a name from a closed set, never a path or a URL; the
gateway client maps it to a fixed path, so the rule against arbitrary targets holds.

**The console's request and its events stay one shape.** The operator's conversation is
written once, in the console's own message form. `internal/cpa/gateway` converts it into the
endpoint's body - `input` and `instructions` for Responses, `messages`, `system` and a
required `max_tokens` for Messages - and decodes that endpoint's stream back into the same
`delta`, `thought`, `usage` and `done` events. Nothing downstream of the gateway knows which
endpoint answered: turns, diagnostics, timing, usage and recovery are unchanged.

**Reasoning effort is translated, not forwarded.** Chat Completions takes
`reasoning_effort`. Responses takes `reasoning.effort`, sent with `summary: "auto"` because
without a summary the stream carries no reasoning text. Messages has no single effort field:
`none` sends `thinking.type: "disabled"`, any other level sends `thinking.type: "adaptive"`
with `output_config.effort`. An operator who needs a different spelling writes it in the
custom request body, which still wins every collision.

**On Responses and Messages the custom request body may not replace the conversation.**
The image checks - inline data URLs only, bounded size and dimensions - run on the console's
messages before they are converted. For Chat Completions the merged body is the console's own
schema and is validated whole, so an override of `messages` is checked too. The other two
schemas are ones the console only writes; rather than model them a second time for
validation, an override of `input` (Responses) or `messages` (Messages) is refused by name.
Every other field passes through untouched.

**The Agent loop runs on any of the three.** A round's tools, calls and results are written
in the endpoint's schema - `function_call` and `function_call_output` items for Responses,
`tool_use` and `tool_result` blocks for Messages, every result of one reply returned in a
single user message - and each stream's calls are assembled whole before any is executed. A
Messages reply's signed reasoning blocks are kept on the assistant message and sent back
ahead of its calls, which that schema requires once thinking is on; the other two endpoints
never see them. A Messages round states a 16384-token limit. The endpoint is fixed for a
turn: a run resumed after an approval continues on the endpoint the turn started with,
because its calls are replayed in the schema they were made in.

**What a message is sent with is chosen in the composer, on both pages.** The composer foot
carries three chips: the endpoint leading it, then reasoning effort and the model beside
send. The Playground's model chip is the Agent's `TargetChip`, with the client key at the
foot of its list; its head keeps the title and the page actions. The endpoint chip carries a
neutral mark and the endpoint's short name; its list gives the full name and the path. The
Playground stores the endpoint with the key and model in `playground_session` and on each
turn's request snapshot, so a retry replays the endpoint it used; the Agent stores it in the
`agent_target` preference and on the conversation.

## Consequences

- The gateway client carries three request shapes and three stream decoders for each of the
  two surfaces, each with its own tests. A change CPA makes to one endpoint's stream is a change to one decoder.
- A Messages request always states a token limit: 4096 when the operator set none, because
  the schema cannot express "the model's default".
- The mapping for Messages effort follows the current schema (`adaptive` thinking with an
  output effort). A model or CPA build that predates it rejects the pair; the operator's
  recourse is the custom request body or leaving effort at the default.
- Effort is no longer free text. A stored level outside the named ones stays selectable, and
  a provider-specific level is otherwise set through the custom request body.
- The panel's Reset no longer clears reasoning effort, which it no longer shows.
- The Playground's head has no refresh action; refreshing the key and model lists is on the
  model chip's list, as on the Agent page.
- On a phone the Playground's composer has a foot row where it had none, so it is one row
  taller; on a narrow foot the model's name is what shortens.
- An Agent conversation stores signed reasoning for the length of a Messages turn's tool loop.
- A model whose output limit is under 16384 tokens rejects an Agent round on Messages.
