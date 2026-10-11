-- Claude reset grants survive the snapshot roundtrip: the refresh result
-- carries them, but the persisted snapshot previously kept only windows,
-- plan and reset credits, so the next GET lost the grants.
ALTER TABLE quota_snapshots ADD COLUMN reset_grants_json TEXT;
