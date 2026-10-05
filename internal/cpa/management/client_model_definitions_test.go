package management

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestStaticModelDefinitionsAllowsOnlyFixedChannels(t *testing.T) {
	calls := 0
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path != "/v8/management/routing/model-definitions/codex" {
			t.Errorf("unexpected path: %s", request.URL.Path)
		}
		io.WriteString(writer, `{"models":[{"id":"gpt-5","name":"GPT-5","secret":"discarded"}]}`)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "management-fixture", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	models, err := client.StaticModelDefinitions(context.Background(), "codex")
	if err != nil || len(models) != 1 || models[0].ID != "gpt-5" {
		t.Fatalf("models=%#v err=%v", models, err)
	}
	for _, channel := range []string{"unknown", "../config", "https://example.test", "codex?secret=1", "codex/../../config"} {
		if _, err := client.StaticModelDefinitions(context.Background(), channel); err == nil {
			t.Errorf("accepted channel %q", channel)
		}
	}
	if calls != 1 {
		t.Fatalf("invalid channels reached CPA: %d", calls)
	}
}
