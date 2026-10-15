# ADR 0100: A font library served from the console's own origin

Status: Accepted
Date: 2026-10-16

## Context

The console draws everything in one bundled typeface, Sarasa Mono SC, cut into
`unicode-range` shards (ADR 0094). Readers found a monospaced interface tiring for long
reading and asked for the typeface to be a setting, with common families on offer
(issue #208).

Two constraints shape the answer. The console loads nothing from another origin - no CDN,
and its own policy allows fonts only from itself or inline (`font-src 'self' data:`) - so
linking a Google Fonts stylesheet from the page is not available. And a deployment must
keep working with no network once it is set up, so a typeface cannot depend on a host
being reachable every time a page loads.

## Decision

**One library, two roles.** The operator chooses an interface font (`ui`) and a
monospace font (`mono`) separately, in OMC Settings → Appearance, stored as the
`omc_fonts` preference. Each role names a built-in typeface (the bundled Sarasa Mono SC,
which stays the default, or the platform's own sans-serif, serif or monospace stack) or
a family from the deployment's font library. The shape follows WordPress's Font Library:
installing a family and choosing one for a role are separate acts, so a choice never
downloads anything and repaints the console on the frame it is made. The settings page
carries only the two role pickers; installing, uploading and deleting families happen in a
library dialog it opens.

**The library is filled by the server and served from the console's origin.** A family
arrives in one of two ways:

- *Upload.* WOFF2, WOFF, TrueType or OpenType files, recognised by signature rather than
  by name or declared type. Weight, style, weight axis and family are read from the
  font's own `OS/2`, `fvar` and `name` tables where the container exposes them (WOFF2's
  Brotli-compressed tables are read from the file name instead).
- *Google Fonts.* The server requests the family's stylesheet with a current browser's
  identity, which yields woff2 files cut into `unicode-range` slices, and downloads every
  file it names. Only regular and bold are installed, the two weights the console's type
  scale uses. Downloads are confined to Google's font hosts or the configured mirror's
  registrable domain (`OMCPA_GOOGLE_FONTS_URL`), with public suffixes and private tenant
  boundaries respected. Same-site subdomains are allowed; IP and local mirror hosts
  require an exact hostname match. The same restriction applies to redirects, so a
  stylesheet cannot point the server outside this boundary.

Both are stored in SQLite (`fonts`, `font_faces`, migration 042) and served from
`/fonts/{id}/faces/{faceId}`, immutable under their ids. The browser declares each face
with its stored `unicode-range`, so, as with the bundled typeface, it downloads only the
slices a page draws. A family is declared under its library id rather than its own name,
so a local copy of the same family cannot stand in for the stored one. Every role falls
back to the bundled typeface, which draws any character a chosen family lacks.

**The choice paints the first frame.** The resolved roles are mirrored in localStorage,
the way the theme is, so the next visit and the sign-in screen paint in the chosen face
before any request.

**Deleting a family clears the roles that used it** in the same transaction, and a role
reference is checked against the library when it is written.

## Consequences

- The server makes an outbound request only when an operator installs a family from
  Google Fonts. A deployment that cannot reach Google can name a compatible mirror, or
  upload the files; once installed, nothing about a family needs the network.
- The page's offline contract is unchanged: every font file the browser loads comes from
  the console's origin.
- A Chinese family costs about 10–20 MB of database per install. The library is bounded
  to 32 families, an install to 96 MiB and a file to 32 MiB.
- Exported conversations keep embedding the bundled monospace face (their portable
  look is the console's default, not the reader's preference).
- The demonstration has an empty library and refuses installs, uploads and deletions.
