# ADR 0075: Agent messages take images, kept beside the conversation

- Status: Accepted
- Date: 2026-10-08
- Supersedes the "Images are not taken" decision of
  [ADR 0074](0074-agent-attachments-are-text-inside-the-message.md). Text files still
  travel inside the message as that ADR describes.
- Extends [ADR 0041](0041-agent-runs-speak-ag-ui-and-render-with-assistant-ui.md): a
  run's one user message may be multi-part.

## Context

Operators hold what they want to ask about as pictures as often as text: a
screenshot of an upstream's error page, a dashboard from another tool, a chart from
a report. ADR 0074 left images out because the Agent resumes a turn from what the
server stored, and an image either has to be stored or the resumed model no longer
sees what it was asked about.

The cost of storing was the argument against it. The conversation is one encrypted
document rewritten on every round of every turn, capped at 900 KiB; a single
screenshot is larger than that. But the Agent is the console's primary surface, the
models it drives read images natively, and "paste it into the Playground instead"
gives up capabilities, history and approvals for one picture.

## Decision

**An image travels beside the message, as bytes.** A run's user message is either a
string, as before, or AG-UI parts: at most one `text` part and up to four `binary`
parts carrying `mimeType` and base64 `data`. A part that names a `url` is refused -
the server never fetches on a message's behalf. Each source image is at most 5 MiB decoded,
must be PNG, JPEG or WebP, and its leading bytes must match its declared type. Before storage, the browser
normalizes Agent images to WebP, at most 2048 pixels on the long edge and 512 KiB, so repeated context
remains compact without changing the original file validation contract. A
message may be images alone.

**The server stores each image as its own document.** Images are `agent_documents`
of kind `image` (migration 036), encrypted like every other Agent document and one
row each. The conversation holds a reference per image - identifier, media type and
size - on the turn that carries it, so the conversation document stays as small as
it was and is still rewritten whole on every round.

**An image lives exactly as long as its turn.** It is deleted when the turn is
evicted from the conversation's window or the conversation is reset. A retry or an
edit of the newest turn keeps that turn's images: the replacing message inherits the
references, and the documents are not rewritten.

**The model sees the newest images on every round.** Each request loads the image
documents its messages reference and sends them as `image_url` parts with data URLs.
Only the newest eight images in the conversation are loaded; an older one is
replaced by a short text note that an image was attached and is no longer shown, so
a long conversation's request does not grow without bound and the model is told what
it cannot see. Image bytes are not counted against the request's text ceiling; the
ceiling exists to bound what capability results add to a request, and images are
bounded by count and size instead.

**The console reads an image from one endpoint.** `GET /api/v1/agent/images/{id}`
serves an image only while the current conversation references that identifier,
under the session authentication every console request uses, with `nosniff`, a
sandboxing content security policy and a private immutable cache lifetime. The
public demonstration refuses the route.

**The composer takes both kinds of attachment through one control.** A file whose
declared type is an image is checked as an image and previewed as a thumbnail; any
other file is checked as text (ADR 0074). Images can be picked, dropped or pasted.

## Consequences

- The Agent database grows by up to four images of 5 MiB per message for as long as
  their turns stay in the conversation window. `repository.MAX_AGENT_DOCUMENT_BYTES`
  rises to 8 MiB to hold one base64-encoded image; the conversation's own 900 KiB cap
  is unchanged.
- A run request body may now be tens of megabytes. The run endpoint's body limit is
  raised for it; every other limit on a message's text stands.
- Whether the selected model reads images is not checked before sending. A model
  that does not is the upstream's error to report, shown as any failed run is; the
  reference catalog's modality data is advisory and would wrongly block models it
  does not know.
- Requests that carry images cost upstream tokens on every round of the turn and of
  the turns after it, until the image falls outside the newest eight.
- An exported conversation embeds the images the console could read at export time,
  so the file stands alone; the JSON export carries the references only.
- External agents over MCP are unaffected: images are part of the built-in Agent's
  run protocol, not of any capability.
