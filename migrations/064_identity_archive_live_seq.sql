-- Decouple verified live credential generation order from metadata refresh timestamps.
ALTER TABLE archived_credentials ADD COLUMN live_generation_seq INTEGER NOT NULL DEFAULT 0;
