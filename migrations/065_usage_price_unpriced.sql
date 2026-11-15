-- A request that found no price when it happened may be priced once, when an
-- operator asks to price it at the current price. Every other change to a
-- recorded request's pricing stays refused: a locked price never moves, and a
-- priced request never returns to unpriced.
DROP TRIGGER usage_cost_no_reprice;
CREATE TRIGGER usage_cost_no_reprice BEFORE UPDATE OF cost_nanos, price_version_id, pricing_status, channel_version_id, price_tier ON usage_events
WHEN (OLD.cost_nanos IS NOT NEW.cost_nanos OR OLD.price_version_id IS NOT NEW.price_version_id OR OLD.pricing_status IS NOT NEW.pricing_status
  OR OLD.channel_version_id IS NOT NEW.channel_version_id OR OLD.price_tier IS NOT NEW.price_tier)
 AND NOT (OLD.pricing_status = 'unpriced' AND OLD.cost_nanos IS NULL AND OLD.price_version_id IS NULL
  AND NEW.pricing_status = 'priced' AND NEW.cost_nanos IS NOT NULL AND NEW.price_version_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'request pricing is immutable'); END;
