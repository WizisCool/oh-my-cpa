# ADR 0043: Agent approval is decided inline, under the call that raised it

- Status: Accepted
- Date: 2026-09-29
- Supersedes: the dialog presentation of [ADR 0035](0035-agent-authorization-is-one-decision.md)

## Context

ADR 0035 made an approval one allow-or-deny decision and presented it as a dialog that opened as
soon as a run stopped for it. The decision held up; the dialog did not. It covered the answer the
operator was deciding about - often the model's explanation of why it wanted the change - and it
covered the conversation on a phone entirely. With runs now stopping on an explicit AG-UI interrupt
naming the call that raised it (ADR 0041), the natural place for the decision is that call.

## Decision

An approval is drawn as a card in the transcript, directly under the capability call that prepared
it, through assistant-ui's native tool approval:

- The card shows what ADR 0035 requires - the capability, its permission, the target, the prepared
  changes and, for a destructive capability, the "cannot be undone" line - and one Allow and one
  Deny. A private input (a secret, an OAuth hand-off) is collected on the card and posted only to
  the decision endpoint.
- While a decision is open the composer refuses to send and says so, with a control that brings
  the card into view and focuses it; the call chain holding it opens by itself.
- Deciding continues the run: the page resumes the interrupt it decided. A decision made in another
  tab is picked up by polling the open operation and continues the run here too.
- A question (`ask_question`) keeps its place in the composer, as ADR 0035 decided; it now reaches
  the run through the framework's resume-tool-call channel, which lands in the same continuation.

Everything else in ADR 0035 stands: one decision, no typed challenge, the revision binding, one-time
consumption, the audit trail and the rule that external agents cannot approve.

## Consequences

- The operator reads the reason for a change and decides it in one place, and nothing covers the
  conversation.
- A waiting approval can scroll out of view; the composer's notice is what keeps it from being
  missed.
