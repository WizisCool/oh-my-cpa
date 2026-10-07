# ADR 0071: Panels are a block vocabulary with open icons

- Status: Accepted
- Date: 2026-10-08
- Extends [ADR 0042](0042-display-tools-draw-referenced-frozen-data.md): `render_view` is a third
  display tool. Charts and tables keep referencing their rows exactly as ADR 0042
  decided; nothing there changes.

## Context

The Agent could show data in two ways: a chart of one of five types, or a table.
Anything else it had to say in Markdown, where HTML is escaped and images are links.
An answer such as "three figures that matter, one credential that needs attention,
and the page to open next" has a natural shape, and the model had no way to give it
one. The icons on the page were the console's own decoration; the model had no icon
channel at all.

Two ways of opening this up were considered and rejected as the first answer:

- **Let the model write markup.** Flexible, but every answer then looks like its
  author rather than like the console, follows no theme, and has to be isolated from
  the page. That is a real need for a small class of visuals and is ADR 0072; it is
  the wrong default for a summary.
- **Adopt a generative-UI component library.** The vocabulary and its validation
  would belong to the library, its props would arrive unchecked from the model, and
  none of the candidates draws from OMC's tokens without a second styling system.

## Decision

`render_view` takes a title and one to eight **blocks**, drawn top to bottom as a
**panel**. The vocabulary is closed and small:

| Block | What it says |
| --- | --- |
| `stats` | Headline figures: label, value, optional change, tone and icon |
| `fields` | The facts of one thing, as labels and values |
| `callout` | One highlighted message, toned info, success, warning or danger |
| `steps` | Ordered stages, each done, active, pending or failed |
| `meters` | Shares of a limit, as a filled fraction with an optional tone |
| `links` | Console pages to open next |

The model chooses blocks and writes their text. The console decides every pixel: a
block is drawn from the same tokens as the rest of the workspace, so a panel follows
a theme switch, reads at any width, and exports like the rest of the conversation.

**One shape for every block.** All block types share one JSON shape (`type`, `title`,
`tone`, `text`, `items`), and all items share another. The schema the model is sent
on every round is therefore a few hundred bytes however many block types exist. Which
fields a type reads is enforced in `resolveView`; a field a type does not read is
dropped, not stored, and an unknown field is refused.

**Icons are open, and can never fail a view.** An item's `icon` is any Lucide name,
or `brand:<maker>` for a maker's mark. The server checks only its length and
character set. The console resolves it - tolerating the spellings models produce,
and following a retired Lucide name to its replacement - and draws a neutral mark for
a name nothing answers to. The Lucide set is one generated JSON document
(`web/src/generated/lucideIcons.json`, written by `pnpm icons:generate` and pinned to
the installed package by a self-test), loaded the first time a panel shows an icon:
importing the set as components would put two thousand modules in the startup graph,
and importing each on demand would embed two thousand chunks in the binary.

**Links name pages, never URLs.** A `links` item carries a `route` from a closed
list of console pages. The console resolves it under its own base path, so a panel
cannot lead outside the deployment.

## Consequences

- **A panel's figures are the model's statements.** A chart or table shows rows the
  server resolved from a capability result; a panel shows text the model wrote, the
  same as the sentences beside it. This is deliberate - a headline figure is usually
  derived (a total, a share, a formatted amount) and has no single cell to reference
  - but it means a panel carries the model's accuracy, not the capability's. The
  system prompt tells the model to copy figures exactly and name their window, and
  data that must be the capability's own figures still belongs in a chart or a table.
- The presentation rules no longer hold displays back until the operator asks for
  one. They ask for the one display that fits best when structure is clearer than
  sentences, and keep the earlier discipline: displays are final-answer artifacts,
  never progress reports, and the smallest complementary set.
- A new block type is a server validation branch, a console component, an export
  branch and a line in the tool description. It costs nothing in schema bytes.
- An exported HTML page inlines Lucide icons as SVG. Maker marks are files the page
  cannot carry and are left out; links are kept as the names of the pages they led to.
