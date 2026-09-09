-- Add auto_sync_interval_hours to pricing_sync_state.
-- 0 = disabled, otherwise interval in hours (1, 6, 12, 24, etc.). Default is 24.
ALTER TABLE pricing_sync_state ADD COLUMN auto_sync_interval_hours INTEGER NOT NULL DEFAULT 24;
