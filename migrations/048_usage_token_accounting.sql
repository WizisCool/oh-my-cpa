-- NULL preserves the original interpretation and locked prices of historical
-- requests. Canonical evidence applies only to records decoded after upgrade.
ALTER TABLE usage_events ADD COLUMN token_accounting TEXT
    CHECK (token_accounting IS NULL OR json_valid(token_accounting));

CREATE TRIGGER usage_token_accounting_no_rewrite BEFORE UPDATE OF token_accounting ON usage_events
BEGIN
    SELECT RAISE(ABORT, 'usage token accounting is immutable');
END;

-- Keep raw-versus-canonical evidence after detail retention. Existing fact rows
-- have no such evidence; zero observed requests is not a claim of zero raw usage.
ALTER TABLE usage_facts_15m ADD COLUMN canonical_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN unresolved_accounting_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN raw_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN raw_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_15m ADD COLUMN raw_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN canonical_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN unresolved_accounting_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN raw_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN raw_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_daily ADD COLUMN raw_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN canonical_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN unresolved_accounting_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN raw_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN raw_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_facts_local_daily ADD COLUMN raw_total_tokens INTEGER NOT NULL DEFAULT 0;
