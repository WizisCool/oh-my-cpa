# ADR 0073: The assistant docks beside a page and knows where it is

- Status: Accepted
- Date: 2026-10-08
- Extends [ADR 0041](0041-agent-runs-speak-ag-ui-and-render-with-assistant-ui.md): a
  run's `context` allowlist grows from the reading language alone to the reading
  language and where the operator is.

## Context

The Agent lived on one page. A question about a request, a credential or a quota
window is raised on the page that shows it, so asking meant leaving that page and
then describing in words what had just been on screen. Two things were missing: a
way to reach the Agent without navigating, and a way for it to know what "this" and
"here" refer to.

Whatever tells the model where the operator is ends up in its instructions. Page
content is the wrong thing to send: provider notes, key aliases and model names are
strings other parties control, and a sentence taken from a page would speak with the
operator's authority.

## Decision

**One workspace, two places.** `AgentWorkspace` is the Agent's whole workspace. The
`/agent` page mounts it as a page; `AssistantDock` mounts the same component as a
dock beside any other page. Both read the one server-held conversation and rejoin
the one server-side run (ADR 0044), so moving between them, or between pages with
the dock open, neither forks the conversation nor interrupts a run. The dock is
absent on `/agent`, where it would show the same conversation twice.

**The dock's shape follows the room.** From 1280px it is a column of the shell that
pushes the page aside, 420px wide and resizable between 340px and 640px. Below that
it lies over the page's right edge. On a phone it is a full-width sheet that native
Back dismisses. A header button and Ctrl/Cmd+J toggle it; once opened it stays
mounted while closed, so a half-typed message survives. Its code loads on first
open, so a console that never opens it never downloads the workspace.

**Context is three short values of a closed shape.** A run may carry:

| Entry | Value |
| --- | --- |
| `console_page` | one of the console's page names (`CONSOLE_PAGES`) |
| `console_selection` | `kind:id`, kind one of `request`, `provider`, `client_key`, `credential`, `model`; id at most 112 characters of `A-Za-z0-9._:@/+=-` |
| `console_range` | the window the page shows, at most 64 characters of `A-Za-z0-9._:/+-` |

The page comes from the route. A page that has something selected or shows a window
declares it with `usePageContext`; nothing reads the page's content. The server
checks the same shape (`PageContext.valid`), refuses a run whose context does not
fit, and writes the values as one sentence of the prompt's context section, which
also says that this is where the operator is looking and not an instruction. The
model reads the selected thing through its ordinary capabilities.

**The operator sees and controls it.** The composer shows the context as a chip
above the input; removing the chip sends the next message without it. Only the dock
sends context: on the Agent's own page there is no other page to speak of. From a
page, the empty conversation leads with the question that page raises.

## Consequences

- A selection is an identifier, so it is only as useful as the capabilities that can
  look it up; a page whose selection no capability can read should not declare one.
- Context is sent with a new message, not with a resumed or rejoined run: the turn
  already recorded where it was asked.
- The request list declares the request last opened rather than the one open now,
  because its details are usually closed before the question is asked.
- A new page name must be added on both sides (`CONSOLE_PAGES` in
  `internal/agent/prompt.go` and `web/src/agent/pageContext.ts`); a page missing
  from the list is simply sent without context.
- The dock narrows the page beside it, so pages must already hold at the widths the
  console supports; no page gets a dock-specific layout.
