package outbound

import (
	"context"
	"net/http"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestProxyPolicy(t *testing.T) {
	ctx := context.Background()
	db, err := repository.Open(ctx, "file::memory:?cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	store := repository.OutboundProxyStore{Repo: repository.New(db), Cipher: cipher}
	transport := NewTransport(store)
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://public.example.test/resource", nil)
	if err != nil {
		t.Fatal(err)
	}
	settings := repository.OutboundProxySettings{Mode: ModeProxy, URL: "http://user:password@proxy.example.test:8080", NoProxy: ".internal.test"}
	if err := Validate(settings); err != nil {
		t.Fatal(err)
	}
	revision, err := store.Save(ctx, 0, settings)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := transport.Proxy(request)
	if err != nil || proxy == nil || proxy.String() != settings.URL {
		t.Fatalf("proxy = %v, %v", proxy, err)
	}
	internal, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://service.internal.test/", nil)
	proxy, err = transport.Proxy(internal)
	if err != nil || proxy != nil {
		t.Fatalf("excluded proxy = %v, %v", proxy, err)
	}
	loopback, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8123/", nil)
	proxy, err = transport.Proxy(loopback)
	if err != nil || proxy == nil {
		t.Fatalf("unexcluded loopback must use the selected proxy: %v, %v", proxy, err)
	}
	settings.NoProxy = "127.0.0.0/8"
	revision, err = store.Save(ctx, revision, settings)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err = transport.Proxy(loopback)
	if err != nil || proxy != nil {
		t.Fatalf("explicitly excluded loopback = %v, %v", proxy, err)
	}
	if _, err = store.Save(ctx, revision, repository.OutboundProxySettings{Mode: ModeDirect}); err != nil {
		t.Fatal(err)
	}
	proxy, err = transport.Proxy(request)
	if err != nil || proxy != nil {
		t.Fatalf("direct proxy = %v, %v", proxy, err)
	}
}

func TestProxyValidation(t *testing.T) {
	for _, raw := range []string{"", "ftp://proxy", "http://proxy/path", "http://proxy?password=secret", "http://proxy:65536", "http://user:%5Bredacted%5D@proxy:8080"} {
		if err := Validate(repository.OutboundProxySettings{Mode: ModeProxy, URL: raw}); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	for _, raw := range []string{"http://proxy:8080", "https://proxy:8080", "socks5://proxy:8080", "socks5h://proxy:8080"} {
		if err := Validate(repository.OutboundProxySettings{Mode: ModeProxy, URL: raw}); err != nil {
			t.Fatalf("rejected %q: %v", raw, err)
		}
	}
}
