-- Display conversion is a replaceable reference-data snapshot, separate from
-- immutable USD price versions and request costs.
CREATE TABLE exchange_rate_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rates_json TEXT NOT NULL CHECK (json_valid(rates_json) AND json_type(rates_json) = 'array'),
    updated_at_ms INTEGER NOT NULL DEFAULT 0,
    attempted_at_ms INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT ''
);
