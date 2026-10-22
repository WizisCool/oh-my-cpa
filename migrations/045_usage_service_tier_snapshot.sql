-- A NULL selection belongs to the original response-first billing policy.
-- New records store even an empty selection so later policy changes cannot
-- reinterpret their immutable request costs.
ALTER TABLE usage_events ADD COLUMN billed_service_tier TEXT;
ALTER TABLE usage_events ADD COLUMN billed_service_tier_source TEXT
    CHECK (billed_service_tier_source IN ('', 'request', 'response'))
    CHECK ((billed_service_tier IS NULL) = (billed_service_tier_source IS NULL))
    CHECK (billed_service_tier = '' OR billed_service_tier_source IN ('request', 'response'));

CREATE TRIGGER usage_tier_snapshot_no_update
BEFORE UPDATE OF billed_service_tier, billed_service_tier_source ON usage_events
WHEN OLD.billed_service_tier IS NOT NEW.billed_service_tier
  OR OLD.billed_service_tier_source IS NOT NEW.billed_service_tier_source
BEGIN
    SELECT RAISE(ABORT, 'usage service-tier snapshots are immutable');
END;
