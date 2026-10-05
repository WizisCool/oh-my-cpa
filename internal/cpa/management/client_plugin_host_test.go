package management

import "testing"

func TestPluginResourcePathAcceptsOnlyAPluginsOwnTree(t *testing.T) {
	cases := []struct {
		raw      string
		pluginID string
		ok       bool
	}{
		{"/v0/resource/plugins/logger/console", "logger", true},
		{"/v0/resource/plugins/logger/assets/app.js", "logger", true},
		{"/v0/resource/plugins/logger", "", false},
		{"/v0/resource/plugins//console", "", false},
		{"/v0/resource/plugins/logger/../other/console", "", false},
		{"/v0/resource/plugins/logger/a\\b", "", false},
		{"/v0/resource/plugins/logger/a\x00b", "", false},
		{"/v0/management/config", "", false},
		{"v0/resource/plugins/logger/console", "", false},
		{"https://elsewhere.example/v0/resource/plugins/logger/console", "", false},
	}
	for _, tc := range cases {
		_, pluginID, ok := PluginResourcePath(tc.raw)
		if ok != tc.ok || (ok && pluginID != tc.pluginID) {
			t.Errorf("PluginResourcePath(%q) = (%q, %v), want (%q, %v)", tc.raw, pluginID, ok, tc.pluginID, tc.ok)
		}
	}
}

// The plugin host must reach routes plugins registered and none of CPA's own: a core
// root answers with unmasked configuration, credentials or logs.
func TestPluginRoutePathRefusesCPAsOwnManagementRoots(t *testing.T) {
	allowed := []string{
		"/v0/management/clinepassbridge",
		"/v0/management/clinepassbridge/accounts/1",
		"/v0/management/logger/status",
	}
	for _, raw := range allowed {
		if _, ok := PluginRoutePath(raw); !ok {
			t.Errorf("PluginRoutePath(%q) refused a plugin route", raw)
		}
	}
	refused := []string{
		"/v0/management/config",
		"/v0/management/config.yaml",
		"/v0/management/Config.YAML",
		"/v0/management/auth-files/download",
		"/v0/management/api-keys",
		"/v0/management/logs",
		"/v0/management/plugins/logger",
		"/v0/management/plugin-store",
		"/v0/management/api-call",
		"/v0/management/",
		"/v0/management/logger/../config",
		"/v0/management/logger//status",
		"/v8/management/logger/status",
		"/v0/resource/plugins/logger/console",
	}
	for _, raw := range refused {
		if routePath, ok := PluginRoutePath(raw); ok {
			t.Errorf("PluginRoutePath(%q) = %q, want it refused", raw, routePath)
		}
	}
}
