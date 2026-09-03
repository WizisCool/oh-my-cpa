-- Console preferences that have to outlive the browser session.
--
-- A reload, a service restart and a container rebuild all drop anything stored
-- client-side, and the operator's chosen time window is exactly the kind of
-- setting they expect to still be there. Values are JSON blobs: the console
-- owns the shape of each key, the database only stores and returns it.
CREATE TABLE IF NOT EXISTS ui_preferences (
    pref_key   TEXT PRIMARY KEY,
    pref_value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
