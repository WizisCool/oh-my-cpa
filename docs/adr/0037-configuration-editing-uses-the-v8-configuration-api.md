# ADR 0037: Configuration editing uses the v8 configuration API

- Status: Accepted
- Date: 2026-09-29
- Implements: [ADR 0034](0034-cpa-v8-is-the-baseline.md), decision 4

## Context

ADR 0034 made CPA v8 the baseline but left the configuration editors on `/v0/management`:
the configuration page, the source view and the Keys page read the stored file, placed
each field by the file's layout (legacy, v8 or mixed) with a relocation table copied from
CPA, and wrote the whole YAML document back through `PUT /v0/management/config.yaml`. A
save guard refused documents CPA v8 would accept and partly ignore. That design existed
to avoid one event: a v8 configuration write migrates a legacy file, rewriting it in
CPA's own layout (four-space indentation, defaults added, unknown sections commented out,
comments of relocated keys moved).

CPA v8's configuration API makes most of that machinery unnecessary. Measured on v8.0.2
(`docs/cpa-v8-compat.md` §4):

- `GET /v8/management/config` and `/config.yaml` render the stored file in the v8 layout,
  whatever layout it is stored in, and never modify it.
- `PATCH /v8/management/config` merges values, `PUT /config/<path>` replaces one path and
  `DELETE /config/<path>` removes it. Each touches only its path; the rest of the file is
  kept as CPA renders it.
- A write that names a legacy field, an unknown section or a value of the wrong type is
  refused (`400`/`422 invalid_config`) with a message naming the offending path, and
  nothing is written.
- The first write to a legacy file converts the whole file, once.

The operator decided (2026-09-28) that the first release requires CPA v8, that a pre-v8
file is converted rather than preserved in its old layout, and that no editing capability
may be lost in the move.

## Decision

1. **The editors read and write the v8 layout only.** The editor schema names v8 paths.
   `GET /management/config` returns CPA's v8 rendering with secrets masked, and its
   revision is the SHA-256 of that rendering. The relocation table, the layout detection,
   the legacy-spelling fallbacks and the save guard are removed.
2. **The visual editor and the Keys page save only what changed.** The console diffs the
   draft against the document it was loaded from and sends `PATCH /management/config`
   with `{revision, changes}`, one change per edited path (`value` or `remove`). The
   backend checks the revision under the provider write gate, restores masked secrets
   per value, and applies the set as one `PATCH` for scalars and lists, one `PUT` per map
   value and one `DELETE` per removal. The answer carries CPA's new rendering, which
   becomes the editor's baseline; a draft with newer edits is carried over onto it.
3. **The source view writes the whole document through `PUT /v8/management/config.yaml`.**
   It edits CPA's v8 rendering, so a legacy name typed there is refused by CPA with its
   own explanation (`422 config_rejected`, shown in the console's language with CPA's
   reason quoted).
4. **A legacy file is backed up before it is converted.** Before any v8 configuration
   write, the client reads the stored file through `GET /v0/management/config.yaml` (the
   only route that returns the file as stored) and, when it is not a v8 file, stores it
   encrypted in `cpa_config_backups` (migration 030, the latest ten kept). If the copy
   cannot be kept, the write is refused before anything is sent
   (`503 config_backup_failed`). The console marks a legacy file on the configuration
   page and offers the kept copies for download (`GET /management/config/backups`,
   `GET /management/config/backups/{id}`, the latter audited as `config.reveal_backup`).
5. **Scalar writes use the same path.** `PUT /management/config/{key}`, which the Agent's
   `config_set` also uses, writes the key's v8 path through the change set instead of a v0
   flat setter.

## Consequences

- The file is no longer preserved byte for byte across the first save. CPA's conversion
  keeps every value it knows and the comments of the keys it moves, adds its defaults,
  and turns unknown sections into comments. The original is recoverable from the backup,
  and every later save is a per-path write.
- A concurrent edit of an unrelated setting is no longer overwritten by a save: the
  revision still refuses a save prepared against a moved document, and the conflict
  dialog's reload now keeps the visual editor's edits on top of the latest document.
- A change set is not atomic across its requests. It is ordered so that the requests CPA
  is most likely to refuse (the merge that carries typed values) come first, but a set
  whose later request fails leaves the earlier ones applied. The editor sends one save at
  a time, and the answer re-reads CPA, so the console shows the state CPA holds.
- `/v0/management` keeps three roles (`internal/cpa/management/client_v0.go`): the
  per-family credential lists (the only source of `auth-index`), the stored-file read
  the backup needs, and the writes whose editors have not moved yet (provider
  credentials, OAuth model aliases, per-plugin enablement and settings).
- The masked view now also masks upstream `api-key` values wherever they appear; the
  v8 layout's `api-keys.<family>` groups made them part of the editor's document.

## Alternatives considered

- **Keep writing whole files through v0 and preserve the legacy layout (ADR 0028's
  rule).** Rejected: it keeps a copied relocation table, a layout-dependent editor and a
  save guard alive only to avoid CPA's one-time conversion, and every save still
  overwrites concurrent edits.
- **Write the whole v8 document through `PUT /v8/management/config.yaml` from the visual
  editor.** Rejected: it has the same overwrite problem and sends every setting for a
  one-field change.
- **Convert without a backup.** Rejected: the conversion drops comments and unknown
  sections, and an operator adopting OMC on an existing gateway must be able to get the
  original back.
