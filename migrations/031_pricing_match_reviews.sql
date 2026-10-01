-- The OpenRouter model an operator has already seen offered for a custom or
-- linked price. The price book offers a model's current candidate (its
-- automatic match, or a suggestion) only while it differs from the one recorded
-- here, so a match that appears after the operator chose their own price is
-- announced once, and a deliberate override is not questioned on every sync.
CREATE TABLE pricing_match_reviews (
    model TEXT PRIMARY KEY NOT NULL,
    upstream_id TEXT NOT NULL,
    reviewed_at_ms INTEGER NOT NULL
);
