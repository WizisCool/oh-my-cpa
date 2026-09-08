-- Display mask for the client API key behind a request record.
--
-- CPA publishes the raw client key with each usage record. We keep the keyed
-- fingerprint (api_group_key) as the identity used for grouping, filtering and
-- credential binding, and store this separate recognisable mask purely so the
-- console can label the caller key without exposing it.
--
-- Rows ingested before this migration keep an empty mask: the request record
-- never kept the raw key, and the fingerprint it does keep cannot be turned back
-- into a mask, so those rows show no key label.

ALTER TABLE usage_events ADD COLUMN api_key_mask TEXT NOT NULL DEFAULT '';
