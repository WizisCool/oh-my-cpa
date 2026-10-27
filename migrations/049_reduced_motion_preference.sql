-- Preserve an explicit scrolling choice with the inverse Reduce motion semantics.
WITH legacy AS (
    SELECT CASE WHEN json_valid(pref_value) THEN json_extract(pref_value, '$') END AS choice,
           updated_at_ms
    FROM ui_preferences WHERE pref_key = 'omc_scroll_smoothing'
)
INSERT INTO ui_preferences (pref_key, pref_value, updated_at_ms)
SELECT 'omc_reduced_motion',
       CASE choice WHEN 'on' THEN '"off"' WHEN 'off' THEN '"on"' ELSE '"system"' END,
       updated_at_ms
FROM legacy WHERE choice IN ('on', 'system', 'off')
ON CONFLICT(pref_key) DO NOTHING;

DELETE FROM ui_preferences WHERE pref_key = 'omc_scroll_smoothing';
