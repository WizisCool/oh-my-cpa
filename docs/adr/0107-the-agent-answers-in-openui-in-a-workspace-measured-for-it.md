# ADR 0107: The Agent answers in OpenUI, in a workspace measured for it

- Status: Accepted
- Date: 2026-10-25
- Supersedes: ADR 0072, ADR 0073, ADR 0079, ADR 0082, ADR 0085, ADR 0087
- Amends: ADR 0080 (one moving element in flight), ADR 0081 (the thread's reading measure)

## Context

The Agent's answers were drawn by a home-grown generative UI: the model wrote `render_ui` payloads
of HTML, CSS and JavaScript, the console froze their rows and rendered them in a sandboxed frame,
and a Canvas Kit inside that frame drew charts and tables. That system owned a parser, a component
catalogue, a sandbox, a capture path and their tests - a second UI stack beside the console's own,
maintained only here.

`@openuidev/react-lang`, `@openuidev/react-ui` and `@openuidev/assistant-ui` now provide that stack:
a streaming-first language, a component library, and tool renderers that integrate with the
assistant-ui runtime this console already runs. Keeping the home-grown one would mean two ways to
draw an answer, two sets of components and two security surfaces.

The workspace also outgrew its measure. One 780px column held the question, the answer, the
composer and, since generative answers arrived, interfaces built for a report. A table or a chart
was squeezed into a reading measure, work-in-flight showed several moving marks at once, and the
footer beside a finished answer carried five unrelated readouts.

## Decision

**Answers are OpenUI programs, drawn by the official renderer.**

- `present_openui` carries the answer as an OpenUI Lang program in its `ui` argument; the official
  toolkit and renderer draw it, and the official parser handles a program that is still streaming.
  OMC writes no parser, renderer, component library or reactive runtime.
- `prompt_openui` is a capability with an `answer` human input, so a form the turn waits on uses the
  executor's existing pending, approval and audit path.
- Asking keeps its console-owned door: `ask_question` returns as a capability, and
  `interrupts/QuestionPanel.tsx` answers it in the composer's place. Its layout - tabs per question,
  numbered options, a typed answer beside them, a review step - is the console's, so it is the same
  in every conversation and does not depend on what a model composes. `prompt_openui` stays for a
  question that genuinely needs a drawn form; the prompt names both and says what each is for, and
  neither renders an approval card.
- A program reads rows a capability returned through `Query("data_rows", {data_ref}, {rows: []})`.
  The reference is value-free, resolves only against the current conversation, and projects the
  listed scalar fields; `database_query` itself is never callable from an interface. A reference
  may name a query's rows: the console withholds a query receipt's raw payload, and projecting the
  fields its `data_sources` listed is what lets an interface draw a result the model already read.
- A rendered program may not load an asset the console does not serve. The program is model output,
  and the console's CSP is report-only, so the fence sits where the answer renders
  (`agent/openui/noRemoteAssets.ts`): same-origin, `data:` and `blob:` stay, anything else loses its
  source and keeps its box.
- Query and Mutation calls reach capabilities through the console's existing executor endpoint, with
  the same permission, approval, audit and invalidation rules as any other console request. The
  renderer hands the console a tool name and its arguments, not whether a Query or a Mutation made
  the call, so a change a program may run is only one the executor would wait on: a low-risk change,
  which would run the moment its call arrived, is refused and stays in the conversation's own flow.
  A high-risk change additionally requires user activation in the browser.
- The instructions that teach the language are generated from the installed official packages by
  `pnpm openui:prompt` and embedded in the server, so the server owns what the model is told and a
  dependency upgrade fails `pnpm check:openui-prompt` when the embedded copy is stale.
- `/text` still asks one answer for Markdown; the OpenUI tools are withdrawn for that turn, so the
  model is never told about a tool it was not given.
- A stored conversation keeps its programs and their receipts, and exports embed inert markup drawn
  by the same official library rather than a model-authored document.

**The workspace is measured around what it draws.**

- The answer and the composer form one 960px column, so the field the operator writes into ends on
  the same edge the answer does; prose inside it keeps a 760px reading measure, and a drawn
  interface carries no OMC frame of its own - the official components are the chrome. Playground
  keeps its single column: the width is a variable the Agent sets, not a change to the shared
  workspace.
- Wide interface lanes are bounded and never cause page-level horizontal scrolling; a table wider
  than a phone scrolls inside its own frame.
- In flight, one element moves. Reasoning carries the live highlight in its own disclosure, a
  running call carries its title, and the activity line speaks only when neither does; the
  three-by-three generation loader is deleted rather than kept beside them.
- A finished answer's footer states success, duration and tokens; the clock, round and call counts
  stay reachable on the status line's tooltip instead of standing as a row of readouts.
- The generated prompt asks for a composition the question needs - a trend, a comparison, a list,
  a form - rather than a fixed dashboard of metrics, chart, table and tabs, and forbids stating the
  same figure twice.
- A form is filled in, not read: inside a prompt the form's column narrows to what a control needs
  instead of the width of the answer, and the answer it was submitted with is drawn as the
  operator's own message under it. Sending - a suggestion chip included - returns the transcript to
  its newest end.

## Consequences

- One UI stack: the console and its generated answers are drawn from the same official components,
  theme tokens and accessibility behaviour.
- The console no longer executes model-authored code: interfaces are React components, so the
  iframe sandbox, the Canvas Kit, the capture path and their tests are gone.
- Provider behaviour bounds perceived streaming: some upstreams deliver a tool call's arguments in
  one chunk after a long reasoning phase. The console reveals a program as it arrives; it cannot
  reveal what arrives at once, and the activity line is what makes that wait legible.
- The OpenUI dependency is load-bearing: a prompt or component change is a dependency change, and
  `pnpm check:openui-prompt` plus the recorded interface checks are what keep it honest.
