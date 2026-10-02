# ADR 0049: Custom icons are durable assets with protected references

- Status: Accepted
- Date: 2026-10-02

## Context

Operators need reusable artwork beyond the embedded catalog. Storing full image Data URLs in the provider preference would duplicate payloads, grow every preference read and prevent meaningful replacement or reference-aware deletion. Files outside SQLite would add a second backup/restore boundary. Arbitrary SVG imports would permit active or remotely loaded content.

## Decision

Store validated static artwork as SQLite assets with stable IDs and monotonic content revisions. Provider preferences retain small string references alongside their existing catalog IDs. File and Base64 imports share server validation; SVG is rebuilt from an explicit static XML allowlist before preview or storage. Authenticated same-origin content responses preserve offline operation and revision-based private revalidation without sending the whole image library in list responses.

Renaming or replacing an asset updates every assignment. Deletion is refused while any persisted mapping references it, including a legacy name key. Assignment validation and deletion checks occur within their respective repository transactions on the existing single SQLite connection. Agent/MCP share the same rules, with explicit revision-bound confirmation for deletion. Plugin-owned identity remains authoritative.

## Consequences

Database backups include artwork automatically. Unsupported SVG styles/resources must be converted to accepted static artwork by the operator; the console does not rewrite unsafe imports silently. The library and individual assets have bounded sizes. Draft provider edits do not hold persisted references, so an asset deleted elsewhere before assignment is rejected when the preference is saved. The existing capability envelope remains smaller than the browser import limit.
