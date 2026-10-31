-- The built-in plugin feature is the default for every gateway binding. Existing
-- rows from the earlier opt-in model are normalized once; later operator pauses
-- are persisted normally. Version pins and removals no longer exist, so those
-- per-plugin choices return to the default enabled state.
UPDATE builtin_policies SET enabled=1, consent=1;
UPDATE builtin_plugin_policies SET state='default', pinned_version='' WHERE state IN ('removed','pinned');
UPDATE builtin_plugin_policies SET pinned_version='';
