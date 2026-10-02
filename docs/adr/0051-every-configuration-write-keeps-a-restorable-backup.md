# ADR 0051: Every configuration write keeps a restorable backup

- Status: Accepted
- Date: 2026-10-02
- Supersedes: Decision 4 of [ADR 0037](0037-configuration-editing-uses-the-v8-configuration-api.md) (a backup only before converting a pre-v8 file). Its other decisions remain unchanged.

## Context

ADR 0037 kept CPA's stored `config.yaml` only before the write that converts a pre-v8 file,
because that conversion is irreversible from CPA. Every other write was unrecoverable from
Oh My CPA as well: a wrong provider edit, a plugin install that rewrote the file, or a
source-view save that dropped a section left the operator to reconstruct the previous file
by hand. The hook that read the stored file before each write already ran before every one
of them; it only discarded what it read when the file was already v8.

## Decision

1. **Every write after which CPA saves the file keeps the stored file first.** The client
   hook (`management.ConfigBackup`) runs before a change set, a whole-document save, a
   plugin install or removal, and a credential status change, and hands the file as stored
   (`GET /v0/management/config.yaml`) to the store whatever its layout. A copy identical to
   the gateway's newest one is not stored twice, so refused retries do not consume the
   retention. A write whose copy cannot be kept is refused before anything is sent
   (`503 config_backup_failed`), except a v8 file with no store configured at all.
2. **Each copy records what it preceded and its layout.** The client method names the kind
   of write (`config_changes`, `config_source`, `provider_keys`, `client_keys`,
   `oauth_aliases`, `plugin_settings`, `plugin_install`, `plugin_delete`,
   `credential_status`, `restore`, `manual`); an outer operation's name wins over the
   method it calls (`management.WithBackupReason`). Copies taken before migration 033 are
   `legacy_conversion`.
3. **Retention is the operator's.** v8 copies are kept to a retention chosen on the
   configuration page (default 20, between 5 and 100, stored in
   `cpa_config_backup_settings`); lowering it deletes the oldest copies at once. Pre-v8
   copies are kept apart, the latest ten, so everyday writes never push out the only
   record of an unconverted file.
4. **Restore happens on the server.** `POST /management/config/backups/{id}/restore`
   decrypts the copy and writes it through `PUT /v8/management/config.yaml` under the
   provider write gate, without a revision check: replacing whatever is there is the
   request. That write keeps the file it replaces like any other, so a restore is undone
   by restoring that copy. The document never reaches the browser. Only a v8 copy can be
   restored, because the v8 API refuses every pre-v8 field name; a pre-v8 copy stays
   download-only rather than reopening a v0 write path. The console withholds restore
   while the editor has unsaved changes.
5. **The rest of the lifecycle is explicit and audited.** A manual copy
   (`POST /management/config/backups`, `config.create_backup`), the retention
   (`PUT /management/config/backups/settings`, `config.backup_settings`), deletion of one
   copy (`DELETE /management/config/backups/{id}`, `config.delete_backup`, fail-closed),
   restore (`config.restore_backup`, fail-closed) and download (`config.reveal_backup`,
   fail-closed) each leave an audit row. None of them is an agent capability: a restore is
   a whole-document write, which agents are not given.

## Consequences

- Each configuration write costs one encrypted insert next to the stored-file read it
  already made. Copies are at most 2 MiB; the worst-case table is bounded by the retention.
- A failing database now blocks every configuration write, not only the conversion of a
  pre-v8 file: the promise that each operation can be undone is kept fail-closed.
- A copy captures an edit made outside Oh My CPA, because it is read just before the next
  write rather than remembered from the last one.
- A restored file is CPA's v8 file as stored; CPA re-validates it, and a copy CPA no longer
  accepts (after a release that renamed a setting) is refused with its reason, leaving the
  file unchanged.

## Alternatives considered

- **Snapshot after each write.** Rejected: it misses edits made outside Oh My CPA between
  writes, and a failed snapshot after a landed write cannot be refused any more.
- **Restore a pre-v8 copy through `PUT /v0/management/config.yaml`.** Rejected: it reopens a
  v0 write path the v8 baseline retired, and CPA silently drops shadowed legacy keys on it.
- **Keep the retention in `ui_preferences`.** Rejected: preferences describe how the
  operator reads the console and are written by an allowlisted generic endpoint; the
  retention changes what the server deletes and needs its own validated write.
