package management

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestPluginMutationIgnoresMaterializedDefaultsButDetectsUnrelatedRuntimeWrites(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(map[bool]string{false: "defaults only", true: "unrelated concurrent change"}[conflict], func(t *testing.T) {
			installed := false
			gateway := &configGateway{stored: "config-version: 8\nplugins:\n  enabled: true\n"}
			gateway.answer = func(method, path string) (int, string) {
				if method == http.MethodGet && path == "/v0/management/config" {
					port := 8317
					if installed && conflict {
						port = 8318
					}
					configs := `{}`
					if installed {
						configs = `{"example":{"enabled":true,"store":{"version":"0.1.4"}}}`
					}
					return 200, fmt.Sprintf(`{"server":{"port":%d},"routing":{"request-retry":0},"plugins":{"enabled":true,"configs":%s}}`, port, configs)
				}
				if method == http.MethodPost && path == "/v8/management/plugins/store/example/install" {
					installed = true
					gateway.stored = "config-version: 8\nrouting:\n  request-retry: 0\nplugins:\n  enabled: true\n  configs:\n    example:\n      enabled: true\n      store:\n        version: 0.1.4\n"
					return 200, `{"status":"installed","id":"example","version":"0.1.4"}`
				}
				return 0, ""
			}
			client := newConfigClient(t, gateway).WithConfigBackup(&recordingBackup{})
			_, err := client.InstallPlugin(context.Background(), "example", "source-fixture", "0.1.4")
			if conflict {
				if !errors.Is(err, ErrPluginMutationConflict) {
					t.Fatalf("unrelated concurrent change = %v", err)
				}
			} else if err != nil {
				t.Fatalf("already-effective defaults were treated as conflict: %v", err)
			}
		})
	}
}
