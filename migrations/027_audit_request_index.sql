-- The audit trail folds an `attempt` row into the outcome the same request recorded
-- for the same action, which looks up rows by (request_id, action). Without this
-- index that lookup scans the whole append-only table once per listed row.
CREATE INDEX IF NOT EXISTS idx_audit_events_request_action
    ON audit_events(request_id, action);
