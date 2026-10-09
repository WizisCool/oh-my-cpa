# ADR 0078: Agent results carry data references and completed turns keep conclusions

- Status: Accepted
- Date: 2026-10-08
- Extends: ADR 0042, ADR 0072, ADR 0073

## Context

An exported usage-analysis run spent 24 model rounds and 35 calls answering one statistics
question. Eleven Canvas calls failed while the model confused operation ids with tool-call ids,
result-envelope paths with data-relative paths, and nested fields with top-level fields.
Completed investigations also replayed SQL and generated HTML in later trivial messages.

The Agent already declares the complete capability catalogue, preserves authoritative traces,
uses executor authorization and freezes referenced rows into sandboxed display artifacts. These
boundaries are valuable; the improvement belongs at the interface between tool results and
subsequent model requests.

## Decision

The Agent runtime adds bounded, value-free dataset descriptors to private model messages.
A descriptor includes a stable `data_ref` derived from the tool-call id and data-relative path,
the legacy source coordinates, selectable scalar fields and row count. Handles are resolved
only against successful, non-display traces retained in the same conversation. They are not
authorization tokens, network addresses or executor operation identifiers.

Canvas accepts `source {data_ref}` with top-level `fields`. Legacy coordinates remain supported.
Schema errors explain declared field paths and types without echoing submitted values. Failed
Canvas calls receive available descriptors; consecutive failures receive targeted repair guidance.
The runtime does not silently correct calls or impose a fixed round/call ceiling.

Completed successful turns contribute their question, images, conclusion and bounded dataset
and operation metadata to later requests. Displayed datasets take priority. Mutation outcomes
and operator refusals remain explicit, and omitted outcomes never imply success. Raw messages,
traces and frozen views stay stored; current-turn context budgeting is unchanged. Missing details
can be queried through existing capabilities.

The system prompt states domain vocabulary, consistent half-open windows, cost-evidence
requirements, and the configured request alias and effort as untrusted metadata. Request aliases
are not claims about actual upstream model identity. Display receipts acknowledge server-side
validation and storage, not successful browser execution.

## Consequences

- A model can reuse a supplied data handle without reconstructing ids and paths.
- Later requests avoid replaying completed SQL/HTML repair transcripts while preserving sources.
- Summaries are deterministic and bounded, not an additional summarization-model request.
- Some historical non-display details require another capability read. Up to eight descriptors
  and eight recent mutation/refusal outcomes are retained per completed turn.
- Dataset inference is bounded to eight references per result, six object levels, 256 visited
  nodes, twelve scalar fields per descriptor and the existing renderable row limit.
- Console projections, MCP results, approval gates, the complete capability catalogue and the
  offline Canvas sandbox retain their existing contracts.
- Source-bound data remains exact; custom unbound markup remains available. Provenance enforcement
  for arbitrary generated JavaScript and browser rendering verification require separate work.

## Verification

Go tests in `internal/agent/data_sources_test.go` exercise reference resolution, private-feedback
boundaries, schema repair, bounded history and a fixture-model follow-up that draws the original
rows without another read. Prompt tests include maximum ordinary aliases and highly escaped
metadata. Existing Agent API projection, authorization, resumption and browser scenarios remain
the regression gates.
