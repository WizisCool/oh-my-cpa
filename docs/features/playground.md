# Playground and models

## Playground

Open **Operate → Playground** under the configured base path. Select an existing client
key and a call point from the live `/v1/models` directory; if no key exists, create one
in Key management first. Real requests consume quota under the selected key. Stop cancels
the connection; the single latest conversation and parameters are stored as a server-side
preference (referencing the key's usage fingerprint, never the raw key).

Keep reverse-proxy streaming unbuffered and its read timeout above the 15-second
heartbeat interval. Weak connections and page refreshes reattach to the active server run
journal (retained for 15 minutes after completion) rather than resending a model call.

## Model directory

The `/model-square` page reads CPA's live `/v1/models` using the first configured client
key (or returns `client_key_required` when none exists) and enriches models from the
bundled models.dev snapshot.
