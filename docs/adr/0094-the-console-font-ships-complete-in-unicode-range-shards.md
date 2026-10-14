# ADR 0094: The console font ships complete in unicode-range shards

- Status: Accepted
- Date: 2026-10-12
- Amends: ADR 0053's distribution anomaly ceiling.

## Context

The console draws everything in Sarasa Mono SC, embedded so the binary works offline. It
shipped as one subset per weight, cut from the characters in `web/src` and committed. Copy
added after the cut was missing from it, and so was any text that only arrives at run time:
Agent and Playground answers, model names, labels people type. The browser drew each missing
character from a system font, so a single label could mix two typefaces. A coverage check
can keep a subset in step with the copy, but no subset can cover what a model writes.

The whole font is about 5 MiB of woff2 per weight. Declared as one file, every first visit
would wait for both weights, and an exported conversation, which embeds its font as data,
would carry about 13.5 MiB of it.

## Decision

1. Ship the complete font, cut into shards declared with `unicode-range`, so a browser
   fetches only the shards whose characters a page draws. The source is a pinned npm
   release, `@fontpkg/sarasa-mono-sc@0.36.0`, checked against its integrity hash; its
   glyphs and typo metrics match the subset it replaces to within 2/1000 em.
2. Shard 000 of each weight is the core: ASCII, Latin-1, common punctuation and every
   character in the console's source. Only it is declared in render-blocking CSS
   (`web/src/assets/fonts/sarasa/core.css`), so the first frame waits for one file per weight.
3. The other shards are registered through the `FontFace` API, from
   `web/src/assets/fonts/sarasa/manifest.json`, by an asynchronous chunk started at
   startup. They are ordered by how common their characters are (GB2312 level 1, Big5
   level 1, GB2312 level 2, Big5 level 2, then the rest by code point), so ordinary Chinese
   text touches a handful of shards.
4. An exported conversation embeds only the shards its own text draws.
5. `pnpm subset-font` regenerates the shards, the manifest, the core stylesheet and a module
   of static `?url` imports for the shard URLs; a self-test holds them to each other and to
   the source copy.
6. Raise the distribution anomaly ceiling from 20 MiB to 32 MiB raw. The other ceilings
   of ADR 0053 are unchanged; the core shards keep startup CSS within its own ceiling.

## Consequences

- The binary, the image and the demonstration grow by about 12.5 MiB (242 files), most
  of which a browser never fetches.
- A character outside the core is drawn by a fallback font until its shard arrives, and
  then swaps. A stale core costs only that swap, never a wrong glyph, so adding copy no
  longer requires regenerating the font.
- Regenerating needs `pyftsubset` (fontTools), as the subset did.
