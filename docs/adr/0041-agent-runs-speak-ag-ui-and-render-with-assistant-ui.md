# ADR 0041: Agent runs speak AG-UI, the console renders them with assistant-ui, and OMC keeps the state

- Status: Accepted
- Date: 2026-09-29

## Context

The Agent's run endpoint streamed an event vocabulary of its own - `delta`, `thought`, `tool`,
`state`, `error` - and the page drew it with Ant Design X's `Bubble.List`, `Sender` and
`ThoughtChain`. Both halves had reached their limits.

**The wire format was private and lossy.** A capability call appeared only when it finished, so a
slow capability read as nothing happening. A run that stopped for the operator ended with a `state`
event whose meaning the browser had to infer from the stored turn. A run the server refused before
it persisted anything answered with a stream that looked the same as acceptance, and the message
the operator had typed was lost behind it. Nothing outside this repository could read the stream.

**The chat components owned state the console needed.** `Sender` kept its own copy of whether a
message could be sent, a render behind the page's, and refused Enter inside that gap; the list
anchored its scroll in reverse, which every geometry probe had to know about; approval, questions,
queued messages, quoting and message actions each needed a bespoke workaround on top of components
that had no concept of them.

Two established pieces now cover exactly these parts. AG-UI (protocol version 1.0) is an open event
protocol for agent runs: typed lifecycle, text, reasoning and tool-call events, state snapshots, and
a run outcome that is either success or a list of interrupts to resume from. assistant-ui is a set
of headless React primitives for a chat thread - viewport, messages, composer, action bars, tool UIs,
approvals, a message queue - with an `ExternalStore` runtime that renders state an application owns.

## Decision

**The run endpoint speaks AG-UI 1.0.** `POST /agent/run` takes a strict `RunAgentInput` and streams
AG-UI events (`internal/agui`: the decoder, the translator and SSE framing; `internal/api` maps the
runtime's events onto it).

- The request carries at most one user message, or a `resume` list naming the interrupts it
  continues from, never both. History, state, assistant or tool messages, unknown tools, unknown
  context entries and unknown fields are refused as `invalid_parameters`: the server owns the
  conversation, and a client that could supply history could forge tool results. The key, model,
  effort and the revision the page last saw travel as `forwardedProps`; the console language is
  the one `context` entry (`console_language`). The only tools a client may declare are the display
  tools (ADR 0042).
- `RUN_STARTED` is sent only after the turn is persisted. A run refused before that emits
  `RUN_ERROR` alone, which the console reads as "not accepted" and hands the message back to the
  composer.
- A capability call is announced (`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`) before it
  executes, and its receipt follows as `TOOL_CALL_RESULT`. Each model round is a step.
- A run that stops for the operator finishes with an `interrupt` outcome naming each waiting
  operation (`approval`, `question`, `secret` or `oauth`) and the call that raised it. The decision
  itself is still made on the decision endpoint (ADR 0035); a resume must name exactly the
  operations that are waiting, and one that is still undecided is refused as `confirmation_pending`.
- The final `STATE_SNAPSHOT` is the stored conversation, and token usage rides on `RUN_FINISHED` or
  `RUN_ERROR`. The runtime's own events stay transport-independent; only the translator knows both
  vocabularies.

**The console renders with assistant-ui over OMC's state.** `web/src/agent/` holds the
framework-free run layer - the AG-UI request builder and event parser, a chunk-safe SSE reader, a
pure reducer that rebuilds the parts the server stores, and the exports. The pages use
`useExternalStoreRuntime`: the stored conversation and the live run's frame are converted to thread
messages, and every action the framework offers - send, stop, approve, answer, regenerate, edit -
comes back through a callback into OMC's own code. assistant-ui never holds the conversation, the
operations or the target; `web/src/pages/agent/runtime.ts` is the one module that knows its runtime
API. The shared shell (`AssistantThread`, `AssistantComposer`) is used by the Playground too, which
keeps its OpenAI-shaped protocol and its own run hook.

The composer asks the runtime to send - on Enter and on the button - rather than using the
framework's own send controls, because those decide from the state their last render saw, which
reaches them a task after the page changed it. A message sent during a run is queued behind it
(`createMessageQueue`, with no cancel, so it never interrupts the run in flight).

## Consequences

- The stream is readable by any AG-UI client, and the console's reducer is a pure fold that the
  logic suite asserts event by event.
- A call is on screen as running before its result exists, a stop for the operator is an explicit
  outcome, and a refused message is never lost.
- `@ag-ui/core` is used for its types and event enum only, so its runtime validators never reach
  the bundle; `@assistant-ui/react` replaces Ant Design X's chat components (`@ant-design/x` stays
  for code highlighting and `@ant-design/x-markdown` for Markdown).
- The endpoint's previous event vocabulary is gone; the console is its only client and ships in the
  same binary, so no compatibility layer is kept.
- The MCP bridge is unaffected: it maps the capability registry, not the Agent's run stream.
