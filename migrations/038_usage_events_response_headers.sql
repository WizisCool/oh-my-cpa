-- The diagnostic part of the upstream's response headers as a JSON object:
-- request identifiers, routing and rate-limit state. Transport headers and
-- anything that can carry a credential are dropped before it is stored
-- (internal/usage/response_headers.go). Empty means none were kept.
ALTER TABLE usage_events ADD COLUMN response_headers TEXT NOT NULL DEFAULT '';
