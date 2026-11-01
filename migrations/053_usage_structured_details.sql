-- Optional upstream observations belong to request detail, not the disjoint
-- token partition or immutable price-book estimate. Historical rows stay unknown.
ALTER TABLE usage_events ADD COLUMN structured_usage TEXT
    CHECK (structured_usage IS NULL OR json_valid(structured_usage));

CREATE TRIGGER usage_structured_usage_no_rewrite BEFORE UPDATE OF structured_usage ON usage_events
BEGIN
    SELECT RAISE(ABORT, 'structured usage evidence is immutable');
END;
