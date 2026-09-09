package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ModelsDevURL is the single fixed official pricing source. The client never
// accepts operator-supplied URLs.
const ModelsDevURL = "https://models.dev/api.json"

const (
	metadataTimeout  = 20 * time.Second
	metadataMaxBytes = 32 << 20
)

// MetadataCost mirrors models.dev cost fields; missing fields stay nil so a
// partial price cannot silently become zero.
type MetadataCost struct {
	Input      *float64 `json:"input"`
	Output     *float64 `json:"output"`
	CacheRead  *float64 `json:"cache_read"`
	CacheWrite *float64 `json:"cache_write"`
}

// MetadataModel is one models.dev model entry.
type MetadataModel struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	LastUpdated string       `json:"last_updated"`
	Status      string       `json:"status"`
	Cost        MetadataCost `json:"cost"`
}

// CatalogEntry is one provider+model pair after decoding.
type CatalogEntry struct {
	ProviderID   string
	ProviderName string
	Model        MetadataModel
}

// Catalog is the decoded models.dev snapshot.
type Catalog struct {
	FetchedAt time.Time
	Entries   []CatalogEntry
}

// MetadataClient fetches and decodes the models.dev catalog. Transport and
// base URL are injectable for tests; production uses fixed HTTPS defaults.
type MetadataClient struct {
	client  *http.Client
	baseURL string
}

func NewMetadataClient() *MetadataClient {
	return &MetadataClient{client: &http.Client{Timeout: metadataTimeout}, baseURL: ModelsDevURL}
}

func NewMetadataClientWithTransport(transport http.RoundTripper, baseURL string) *MetadataClient {
	return &MetadataClient{client: &http.Client{Timeout: metadataTimeout, Transport: transport}, baseURL: baseURL}
}

// Fetch downloads and decodes the catalog. HTTP errors and truncated payloads
// return an error; the caller keeps the last good prices on failure.
func (c *MetadataClient) Fetch(ctx context.Context) (Catalog, error) {
	parsed, err := url.Parse(c.baseURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return Catalog{}, fmt.Errorf("pricing source URL must be http(s)")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL, nil)
	if err != nil {
		return Catalog{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "oh-my-cpa-pricing/2")
	response, err := c.client.Do(request)
	if err != nil {
		return Catalog{}, fmt.Errorf("fetch models.dev pricing: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Catalog{}, fmt.Errorf("fetch models.dev pricing: status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, metadataMaxBytes+1))
	if err != nil {
		return Catalog{}, fmt.Errorf("read models.dev pricing: %w", err)
	}
	if int64(len(body)) > metadataMaxBytes {
		return Catalog{}, errors.New("models.dev pricing exceeds size limit")
	}
	entries, err := DecodeCatalog(body)
	if err != nil {
		return Catalog{}, err
	}
	return Catalog{FetchedAt: time.Now(), Entries: entries}, nil
}

type metadataProvider struct {
	ID     string                   `json:"id"`
	Name   string                   `json:"name"`
	Models map[string]MetadataModel `json:"models"`
}

// DecodeCatalog normalizes the provider/model envelope into a flat list.
func DecodeCatalog(body []byte) ([]CatalogEntry, error) {
	var providers map[string]metadataProvider
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	if err := decoder.Decode(&providers); err != nil {
		return nil, fmt.Errorf("decode models.dev pricing: %w", err)
	}
	entries := make([]CatalogEntry, 0, len(providers)*8)
	for providerKey, provider := range providers {
		providerID := strings.TrimSpace(provider.ID)
		if providerID == "" {
			providerID = strings.TrimSpace(providerKey)
		}
		if providerID == "" {
			continue
		}
		providerName := strings.TrimSpace(provider.Name)
		if providerName == "" {
			providerName = providerID
		}
		for modelKey, model := range provider.Models {
			if strings.TrimSpace(model.ID) == "" {
				model.ID = strings.TrimSpace(modelKey)
			}
			if model.ID == "" {
				continue
			}
			entries = append(entries, CatalogEntry{ProviderID: providerID, ProviderName: providerName, Model: model})
		}
	}
	return entries, nil
}



