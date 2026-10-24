# Handoff: rebuild the OMC Agent on the official OpenUI SDK

> Working note for the next agent. **Delete this file before the final commits**: it is not a
> repository document.

## 1. Where things are

| Item | Value |
| --- | --- |
| Repository | `/root/project/oh-my-cpa` (the frontend is `web/`) |
| Branch | `feat/openui-agent`, cut from `origin/main` at `c0d4e75d` |
| Commits | Two WIP commits (`wip(agent): OpenUI rebuild checkpoint`, then this handoff note), pushed to `origin/feat/openui-agent` so the container's work survives. Rewrite it into atomic commits at the end; force-pushing **this feature branch** is fine. Never merge to `main` or open a PR unless asked. |
| Commit trailer | `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No model identifiers anywhere else. |
| Language | Reply to the user in Chinese. Everything in the repository is in English. |
| Rules | `AGENTS.md` (the root `CLAUDE.md` links to it). Memory index: `/root/.claude/projects/-root-project-oh-my-cpa/memory/MEMORY.md`. |

**State at handoff:**
- `go build ./...` is green.
- `go vet` on `internal/agent` and `internal/api` is green.
- `go test -short ./internal/agent/` passes.
- `cd web && npx tsc --noEmit` passes.
- Not yet run: the `internal/api` test suite, the Node logic and self tests, the `check-*` gates, the bundle check, and any browser check.

## 2. The user's goal, in short

The user's request, quoted where it matters:
- Rebuild the OMC Agent on the **official OpenUI SDKs**: `@openuidev/react-lang`, `@openuidev/react-ui` and `@openuidev/assistant-ui`.
- Prefer `createOpenUIToolkit`, `present_openui`, `prompt_openui` and `openuiChatLibrary`.
- **Do not build any of these yourself:**
  - a parser or streaming parser;
  - a renderer;
  - a component library or reactive runtime;
  - parallel abstractions.

  Do not imitate the demo's look without using OpenUI.
- Write only OMC adapter code: model communication, tools, data binding, theme and permissions.
- Delete everything from the old system:
  - `render_ui`;
  - model-written HTML, CSS and JS;
  - the Canvas Kit and the iframes;
  - the hand-built streaming preview;
  - their tests and docs.
- OpenUI is the default answer. Markdown is the `/text` fallback.
- Keep the backend's auth, permissions, approval and audit. Generated UI must never bypass them, and OpenUI's interactivity stays enabled.
- Verify in a real browser against the openui.com demo, in light, dark and mobile.
- Update the docs, write atomic commits, push the branch, and do not merge.
- **Final report in Chinese**, covering:
  - the official packages used;
  - the modules deleted;
  - the key changes;
  - coverage;
  - the browser verification;
  - open issues.

## 3. Architecture (as implemented)

### Packages

`web/package.json` adds:
- `@openuidev/assistant-ui@0.2.0`
- `@openuidev/react-ui@0.18.1`
- `@openuidev/react-lang@1.0.1`
- `@openuidev/react-headless@0.18.1`
- `zod@^4`
- `zustand@^4.5.5`

`pnpm-workspace.yaml` sets `allowBuilds['@openuidev/lang-core']: false`; that install hook only sends telemetry. React stays on 18.

### Server (Go, `internal/agent`)

**`openui.go`**
- Tools: `present_openui` is the display tool and the turn's answer. `prompt_openui` is a capability with `HumanInput: "answer"`, and the executor's pending and approval flow carries it.
- The submitted form is checked strictly by `readOpenUIAction`: `continue_conversation` only, bounded, with no unknown fields.
- `ReadDataRows` serves the frozen rows behind a `data_ref`.
- `OpenUITools(definitions)` is the capability catalogue for the prompt. It leaves out:
  - human-input capabilities;
  - `database_query`;
  - anything without the agent adapter.
- `isFinalPresentation`: a round that only presents ends the turn.

**Prompt (`openui/openui.json`, ~94 KB)**
- The prompt is generated at **build time**: `scripts/generate-openui-prompt.ts` runs the official `createOpenUIInstructions` with OMC's prompt options from `web/src/agent/openui/prompt.ts`, over `openui/capabilities.json`.
- `capabilities.json` is a golden file written by `TestOpenUICapabilityCatalogue` in `internal/api/agent_http_test.go`.
- Go embeds the result.
- Regenerate with:
  ```sh
  UPDATE_GOLDEN=1 go test ./internal/api -run TestOpenUICapabilityCatalogue
  pnpm openui:prompt
  ```
- Check for drift with `pnpm check:openui-prompt`. It is **not yet wired** into `scripts` `verify-fast` or the static gates; wire it in.

**`prompt.go`**
- `PROMPT_VERSION` is `2026-10-25.1`.
- The presentation section is the generated instructions, or Markdown when the console declared nothing or the turn is `/text`.
- The only presentation the server accepts is `"text"`.

**`data_sources.go`**
- History replays `present_openui` and `prompt_openui` as assistant tool calls with their results.
- Data references are prioritised.

**`runtime.go`**
- `Trace.View` and `Turn.Suggestions` are removed.
- The loop ends on a final presentation.
- `prompt_openui` is withheld when the turn cannot render OpenUI.

### API (`internal/api`)

- **New route:** `POST /api/v1/agent/data-rows` (`agentDataRows`). The demo policy refuses it.
- **Wiring:** `RegisterPromptOpenUI` replaces `RegisterAskQuestion`.
- **Projection:** the projection drops View and Suggestions.
- **Unchanged:** live Query and Mutation calls from rendered interfaces use the existing `POST /capabilities/invoke`. Its executor applies permission, approval and audit.

### Frontend (`web/src`)

**`agent/openui/`**
- `prompt.ts`: OMC's prompt options and the `data_rows` ToolSpec. It is shared with the Node generator.
- `program.ts`: reads a streaming `ui` argument prefix, and detects answer text that is a program.
- `toolProvider.ts`: `OPENUI_TOOL_PROVIDER`, an MCP-shaped `callTool`. It routes:
  - `data_rows` to `/agent/data-rows`;
  - capabilities to `/capabilities/invoke`.

  It refuses:
  - human-input capabilities and `database_query`;
  - non-read calls without user activation.

  A pending result goes to `host.approve` and then the queries are invalidated.
- `theme.ts`: `openUITheme(series)` maps OMC's CSS variables onto OpenUI's tokens. The font shorthands are rewritten to `var(--font-ui)` and `var(--font-mono)`, which keeps the Sarasa default. The chart palette is the resolved series colours, with the first series in the middle.
- `staticRender.tsx`: `renderInterfaces()` draws programs offscreen with the official `Renderer` and `ThemeProvider`.
  - It waits for tool calls to finish and for the DOM to go quiet (MutationObserver, quiet for 300 ms, capped at 8 s).
  - It returns inert, sanitised markup plus the theme's CSS declarations. Exports use it.

**`pages/agent/`**
- `tools/openui.tsx`: `OPENUI_TOOLKIT = createOpenUIToolkit({disableThemeProvider, rendererProps:{toolProvider}, ErrorFallback})`.
  - The error fallback offers to send the error report back to the model.
  - `OpenUIText` renders answer text that is itself a program.
- `tools/registry.tsx`: `AGENT_TOOLKIT = OPENUI_TOOLKIT`.
- `AgentMessage.tsx`:
  - OpenUI tool calls render `part.toolUI` outside the call chain.
  - Program text renders `OpenUIText`.
  - The present chip shows only for `text`.
- `AgentPage.tsx`:
  - It wraps the page in OpenUI's `ThemeProvider`, with `mode` from OMC's `useTheme`, `cssSelector` set to the shell class, and the tokens from `openUITheme`.
  - It mounts `useOpenUIToolHost()`, which returns the approval modal.
  - It removes `QuestionPanel` and `/ui`.
  - `PRESENTATIONS` is text-only.
  - When `prompt_openui` waits, a form hint with **Skip** appears above the composer. Skip calls `decideOperation(id,false)`.
- `useOpenUIToolHost.tsx`: installs the host. Its approval modal reuses `ApprovalCard`, and closing the modal declines the change.
- `runtime.ts`:
  - `onAddToolResult` sends the `prompt_openui` form submission to `decideOperation(id,true,{answer})` and then continues the run.
- `thread.ts`:
  - OpenUI tool parts carry `args.ui`.
  - A stored `present` other than `text` is ignored.

**Export (`agent/conversationSnapshot.ts`, `conversationHtml.ts`, `conversationDownload.ts`, `conversationStyles.ts`, `conversationControls.ts`)**
- The `interface` segment `{program, markup}` replaces figure, panel and canvas.
- `downloadConversation(options, format, prefix, openui)` draws the interfaces offscreen and embeds:
  - `@openuidev/react-ui/components.css?inline`;
  - `.interface{theme vars}`.
- The canvas and panel code, slots and script handlers are gone.
- Labels: `interfaceOmitted` replaces `canvasOmitted`; `step` is removed.

### Deleted so far

| Area | Files |
| --- | --- |
| Go | `internal/agent/display.go`, `display_test.go`, `question.go`, `question_test.go` |
| Agent tools | `web/src/pages/agent/tools/{DisplayCall,CanvasView,FigureDraft,PanelView,AgentIcon}.tsx` |
| Agent modules | `web/src/agent/{canvasKit,canvasDocument,canvasCapture,uiAssets,uiIcons,agentIcons}.ts` |
| Interrupts | `web/src/pages/agent/interrupts/QuestionPanel.tsx` |

## 4. Remaining work, in order

1. **Demo recording.**
   - `web/src/demo/agentRecording.json`'s last call is `render_ui` (`call_499c…`), with `view` and `{"rendered":true}`.
   - Replace it with a `present_openui` call whose `arguments` is `{"ui": {"zh": …, "en": …}}`.
   - Write the program in OpenUI Lang, using **literal** rows from the `database_query` result. That result's rows use `{{iso:-7}}…` day templates (see `recordingTemplate.ts`). Show:
     - three stat tiles: 1,632 requests, 88 failures, 5.4%;
     - a bar/line chart of requests and failure rate per day, with a `Select` and `$metric` to switch between them, if supported;
     - a table;
     - a callout naming the window.
   - Set the result to `{"status":"success","data":{"displayed":true}}`.
   - Drop `view`. Set `"present"` to `null` or remove it, and set `prompt_version` to `2026-10-25.1`.
   - The demo cannot call `data_rows` because the route is refused in demo mode, so the program must embed its data.
   - Validate the program by rendering it, or with `createParser` from react-lang in a scratch script.
   - Fix `scripts/test-demo-replay.ts`, which reads `traces.at(-1).view.title`.
   - Run `pnpm check:demo`.
2. **i18n** in `web/src/i18n/messages/agent.ts` and **both** `web/src/i18n/locales/{zh-Hant,ms}.ts`.
   - Add:
     - `agent.openui.failed`
     - `agent.openui.repair`, the message sent to the model with the error JSON
     - `agent.openui.ask_repair`
     - `agent.openui.approval`, the modal title
     - `agent.openui.form_hint`
     - `agent.openui.form_skip`
     - `agent.error.openui_action`, for "a change in an interface runs only from its button"
     - `agent.export.interface_omitted`
   - Remove the keys nobody reads any more:
     - `agent.present.ui`, `agent.present.canvas` and `agent.command.ui`;
     - the `agent.view.*` keys;
     - the question keys, `agent.question.*`;
     - `agent.export.canvas_omitted`;
     - the follow-up and suggestion keys.

     Grep each one before removing it.
   - Run `pnpm check-i18n`.
3. **`AgentPage.module.css`.**
   - Delete the canvas, question-panel and follow-up styles.
   - Add `.openui` so the wrapper gets full width and a sensible gap. Probably no box: OpenUI draws its own Card.
   - Run `pnpm check-css-modules`.
4. **Grep for leftovers:**
   ```sh
   grep -rn "render_ui\|render_view\|canvas\|QuestionPanel\|ask_question\|DisplayView\|followUp\|suggestions" web/src scripts internal docs
   ```
   - Also `scripts/acceptance/probes/agent.mjs`, plus the probe and browser-acceptance steps for canvas and question.
   - Update or delete these script tests: `scripts/test-agent-workspace.ts` (question functions), `test-answer-layout.ts` (figure becomes `interface`), `test-conversation-export.ts`, `test-demo-replay.ts`.
   - Follow AGENTS §5: add a case, not a file; no tests of the tooling itself.
5. **Tests that must prove behaviour.** Each needs a case that fails without the change:
   - the `/agent/data-rows` handler: an unknown `data_ref` returns an error result; a conversation's reference returns its rows; no leakage across conversations;
   - `readOpenUIAction` (already covered);
   - the tool provider refuses a non-read call without user activation (logic suite);
   - export markup sanitising: `javascript:` hrefs and `on*` attributes are stripped.

   Run `go test -short ./internal/...`, `pnpm test:logic` and `pnpm test:components`.
6. **Gates.**
   - Run `pnpm test:fast`, `pnpm check-docs`, `pnpm check:bundle` and `pnpm check:openui-prompt`.
   - `check:bundle`: OpenUI's CSS is ~363 KB, plus the libraries. Make sure they stay in the lazily loaded Agent chunk, and update the size baseline deliberately if it is needed.
   - Wire `check:openui-prompt` into the static gate.
   - Go source changed, so run `pnpm demo:generate` and commit the dataset diff. Per the memory note, `--check` alone misses a stale digest.
7. **Docs.**
   - Update: `CONTEXT.md`, `docs/architecture.md` (the agent module, data flow, the new route), `docs/design.md` (OpenUI theming), `docs/agent-capabilities.md`, `docs/operations.md`, `PRODUCT.md` and the READMEs if capabilities are listed.
   - Write `docs/adr/0088-…` ("Agent answers through the official OpenUI integration"). The number was planned; check the next free one first.
   - The new ADR supersedes ADRs 0072, 0073, 0079, 0082, 0085 and 0087. Note the reversal in each old ADR's status line. Verify the numbers with `ls docs/adr`.
   - Record the ~94 KB prompt cost as a trade-off.
   - Do not name commercial reference products. The openui.com demo is the official SDK's own demo, so naming OpenUI is fine.
8. **Browser verification.**
   - Start `pnpm dev`; the console is at `http://127.0.0.1:5173/omc/`. Background it with `check:ui`.
   - Use the Playwright Chromium already installed. Use a mocked or real API with a scripted model stream, for example a small fake that streams a `present_openui` call.
   - Check:
     - streaming render;
     - a form through `prompt_openui`, then Skip;
     - a Query calling `data_rows` and a live capability;
     - a Mutation with its approval modal;
     - the error fallback and repair;
     - history reload;
     - HTML and image export;
     - light and dark, desktop and phone (390 px).
   - Compare against the openui.com demo, if the network allows it.
   - Save screenshots to the scratchpad. Never put a secret in them.
9. **Review and commit.**
   - Review the diff.
   - Split the WIP commit into atomic commits, for example:
     1. deps and the prompt generator;
     2. server tools and runtime;
     3. API route;
     4. frontend toolkit and theme;
     5. export;
     6. demo;
     7. removal of the old system;
     8. docs and ADR.
   - Push with `git push -u origin feat/openui-agent` (`--force-with-lease` after the rewrite).
   - Delete this handoff file.
   - Write the final report in Chinese.

## 5. Known risks and open questions

- **`OpenUIFailure` and `OpenUIText`** call `aui.thread().append(...)`. It type-checks, but it has not been exercised at runtime.
- **The `isUserAction` gate** uses `navigator.userActivation.isActive`. A Mutation run by a Button's `@Run` should be inside the activation window. Verify this in the browser.
- **`prompt_openui` submission path:**
  1. assistant-ui's `addResult` calls `onAddToolResult` in `runtime.ts`;
  2. that calls `decideOperation(answer)`;
  3. `onDecided` resumes the run.

  Verify it end to end.
- **The server does not refuse** `/capabilities/invoke` for `prompt_openui` or other human-input capabilities; the client filters them. Consider a server-side refusal, so the boundary does not rest on the client.
- **Chart colours.** `getDistributedColors` spreads series from the middle of the palette, and `openUITheme` reorders the palette for that. Check how the charts look.
- **Export `staticRender`** has not been run in a browser yet.
