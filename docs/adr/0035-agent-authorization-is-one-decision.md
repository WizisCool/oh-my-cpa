# ADR 0035: Agent authorization is one allow-or-deny decision, and the agent may ask the operator

- Status: Accepted
- Date: 2026-09-28

## Context

A capability the Agent calls that changes routing, credentials, availability or configuration
waits for the operator. Until now that took three separate acts: find the approval card in the
transcript beneath the call that prepared it; for a destructive capability, type the target
identifier into a challenge field before the approve button would enable; then press Resume in
the composer so the model could continue. Operators found the flow heavier than the decision it
records, and the typed challenge was the heaviest part of it.

The challenge protected less than it appeared to. The operator reads the target on the same card
they type it from, so typing proves attention to a string, not an understanding of the change.
What actually stops an approval from applying to the wrong thing is the revision the preview was
read at: the executor re-validates it inside the write gate and refuses with `resource_conflict`
when the target changed in between. Those protections do not depend on the challenge.

Separately, the model had no way to ask the operator anything. When a request was ambiguous it
either guessed - and a wrong guess cost a whole turn to correct - or wrote a question into its
answer, which ended the turn and lost the plan it was following.

## Decision

An approval is one decision: allow or deny.

- The preview no longer carries a challenge, and the decision endpoint takes only `approve`, plus a
  `secret` or an `answer` when the operation asks for one. Destructive capabilities keep their
  permission, their danger styling and an explicit "cannot be undone" line; the revision binding,
  the one-time consumption and the audit trail are unchanged.
- The console opens the request as a dialog as soon as a run stops for it, and deciding it
  continues the run. Resume remains only as the fallback when the run cannot continue by itself
  (for example, the selected key no longer exists).

The Agent may ask the operator questions through `ask_question`, registered by `internal/agent`
because it belongs to the conversation rather than to OMC's business operations:

- 1-4 questions per call, each with 0 or 2-6 labelled options, single or multiple choice, and a
  typed answer always available - the shape established coding agents use, because one open
  question per round costs a round trip per detail, while fixed options alone trap the operator
  when none fits.
- It reuses the pending-operation store with a new human input kind, `answer`, which the registry
  allows only on a `read` capability. A question expires after 24 hours rather than 10 minutes,
  since answering it changes nothing. The answer is validated against the questions before the
  operation is claimed, so a malformed answer leaves the question open.
- It is offered to the built-in Agent only; an MCP client has its own way to ask its user.
- The console draws it in place of the composer rather than as a dialog, because the answer text
  above it is often what the operator needs to read to reply, and in the established coding agents'
  shape: a tab per question, numbered options a digit key picks, "Something else" as the last
  option, and a review step before sending. Skip is a denial the model is told of.

## Consequences

Approving a change is one click in a dialog that appears on its own, and the conversation
continues without another step. An operator can no longer be slowed down deliberately by a typed
confirmation; a deployment that wants that friction back would need a new decision, since the
executor no longer accepts a challenge. Model-visible text for a pending operation, the
`uncertain` rule and the rule that external agents cannot approve are unchanged.
