-- Usage facts on the deployment's own calendar days.
--
-- usage_facts_daily is keyed on UTC days, which are local days only where the
-- deployment's time zone sits on UTC. Anywhere else a per-day read had to fold
-- quarter hours, and a ninety-day window over a busy deployment is a third of a
-- million of them. This grain holds one row per dimension tuple per local day in
-- one named zone.
--
-- It is derived, not primary: every row can be recomputed from usage_facts_15m,
-- because every civil offset is a multiple of fifteen minutes. The fold writes it
-- in the same transaction as the other two grains, so the three always cover the
-- same event ids. When the operator changes the time zone the table is rebuilt for
-- the new zone in one transaction; until then reads fall back to the quarter hours.
--
-- day_wall_ms is the local midnight as wall-clock milliseconds - the instant it
-- would be if the zone were UTC - rather than an instant. A wall-clock day is one
-- key on either side of a daylight-saving change, which an instant is not.
CREATE TABLE usage_facts_local_daily (
    instance_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    day_wall_ms INTEGER NOT NULL,
    api_group_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    model_alias TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
    ttft_count INTEGER NOT NULL DEFAULT 0,
    cost_nanos INTEGER NOT NULL DEFAULT 0,
    priced_requests INTEGER NOT NULL DEFAULT 0,
    costed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, zone, day_wall_ms, api_group_key, model, model_alias, auth_index, provider, auth_type)
) WITHOUT ROWID;
