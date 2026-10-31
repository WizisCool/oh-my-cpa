ALTER TABLE cpa_instances ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER cpa_binding_generation AFTER UPDATE OF base_url ON cpa_instances
WHEN OLD.base_url <> NEW.base_url
BEGIN
 UPDATE cpa_instances SET binding_generation = OLD.binding_generation + 1 WHERE id = NEW.id;
END;
CREATE TABLE builtin_catalog (
 id INTEGER PRIMARY KEY CHECK (id=1), sequence INTEGER NOT NULL, envelope BLOB NOT NULL, payload_hash TEXT NOT NULL
);
CREATE TABLE builtin_artifacts (
 plugin_id TEXT NOT NULL, version TEXT NOT NULL, platform TEXT NOT NULL, identity TEXT NOT NULL,
 PRIMARY KEY(plugin_id,version,platform)
);
CREATE TRIGGER builtin_artifacts_no_update BEFORE UPDATE ON builtin_artifacts BEGIN SELECT RAISE(ABORT,'immutable builtin artifact'); END;
CREATE TRIGGER builtin_artifacts_no_delete BEFORE DELETE ON builtin_artifacts BEGIN SELECT RAISE(ABORT,'immutable builtin artifact'); END;
CREATE TABLE builtin_releases (
 plugin_id TEXT NOT NULL, version TEXT NOT NULL, document BLOB NOT NULL, PRIMARY KEY(plugin_id,version)
);
CREATE TABLE builtin_policies (
 instance_id TEXT NOT NULL, generation INTEGER NOT NULL, gateway_id TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, consent INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
 last_reconcile_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(instance_id,generation)
);
CREATE TABLE builtin_plugin_policies (
 instance_id TEXT NOT NULL, generation INTEGER NOT NULL, plugin_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('default','disabled','removed','pinned')), pinned_version TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(instance_id,generation,plugin_id)
);
CREATE TABLE builtin_operations (
 instance_id TEXT NOT NULL, generation INTEGER NOT NULL, plugin_id TEXT NOT NULL,
 version TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
 PRIMARY KEY(instance_id,generation,plugin_id)
);
