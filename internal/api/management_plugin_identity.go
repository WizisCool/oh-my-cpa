package api

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

/**
 * The name and mark an installed plugin is known by, when CPA cannot say.
 *
 * CPA reports a plugin's metadata - its name, author, version and logo - only once the
 * host has loaded it. A plugin that is installed but disabled, or waiting for a restart,
 * arrives with its id alone, so every surface showed `codebuddy` and a placeholder mark
 * for a plugin the operator installed as "CodeBuddy" from the store. The store listing is
 * the other record that knows those values, and CPA joins it with what is installed, so
 * this fills an unregistered plugin's gaps from it.
 *
 * The store is read from its registries, which is slow and may be offline, so its answer
 * is remembered in memory: every read of the store page refreshes it, and the plugin list
 * asks for it itself only when a plugin is missing an identity the cache cannot supply,
 * at most once per retry interval, within a short budget. A value the plugin registered
 * always wins; only an empty field is filled.
 */

const (
	// pluginIdentityFetchTimeout bounds the store read the plugin list may make. The list
	// is on the console's request path, so a slow registry costs this much once, and then
	// the placeholder name is served until the next attempt.
	pluginIdentityFetchTimeout = 5 * time.Second
	// pluginIdentityRetryInterval is how long after a store read - successful or not - the
	// plugin list waits before asking again for an id the cache does not know. It is what
	// keeps a plugin that no registry lists from costing a store read on every poll.
	pluginIdentityRetryInterval = 10 * time.Minute
	// maxPluginIdentityEntries bounds the cache. A store lists every plugin of every
	// configured registry; only the installed ones are kept, and a deployment has a
	// handful, so the cap exists only so a registry cannot decide this map's size.
	maxPluginIdentityEntries = 256
)

// pluginIdentity is what a store listing says about one installed plugin.
type pluginIdentity struct {
	Name    string
	Author  string
	Version string
	Logo    string
}

type pluginIdentityCache struct {
	mu          sync.Mutex
	entries     map[string]pluginIdentity
	lastAttempt time.Time
	// fetching serialises the list's own store reads, so a burst of list requests
	// makes one read rather than one each.
	fetching sync.Mutex
	now      func() time.Time
}

func newPluginIdentityCache() *pluginIdentityCache {
	return &pluginIdentityCache{entries: make(map[string]pluginIdentity), now: time.Now}
}

// remember records the installed entries of a store listing. The raw logo URL is kept, so
// the plugin list inlines it under its own rules rather than reusing another response's.
func (c *pluginIdentityCache) remember(plugins []management.StorePluginItem) {
	if c == nil {
		return
	}
	next := make(map[string]pluginIdentity)
	for _, plugin := range plugins {
		id := strings.TrimSpace(plugin.ID)
		if id == "" || !plugin.Installed || len(next) >= maxPluginIdentityEntries {
			continue
		}
		identity := pluginIdentity{
			Name:    strings.TrimSpace(plugin.Name),
			Author:  strings.TrimSpace(plugin.Author),
			Version: strings.TrimSpace(plugin.InstalledVersion),
			Logo:    strings.TrimSpace(plugin.Logo),
		}
		// Two registries may list the same installed id. The copy CPA says it was installed
		// from describes the file on disk; otherwise the first listing with a name stands.
		if existing, ok := next[id]; ok && existing.Name != "" && plugin.InstallSourceStatus != "matched" {
			continue
		}
		next[id] = identity
	}
	c.mu.Lock()
	c.entries = next
	c.lastAttempt = c.now()
	c.mu.Unlock()
}

// fill completes the identity of every plugin CPA reported without one. It reads the store
// through the client only when a gap remains that the cache cannot close and the last read
// is older than the retry interval; a failed read leaves the plugins as they were.
func (c *pluginIdentityCache) fill(ctx context.Context, client *management.Client, plugins []management.PluginItem) {
	if c == nil || !c.hasGaps(plugins) {
		return
	}
	if c.hasUnknown(plugins) && client != nil {
		c.refresh(ctx, client)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := range plugins {
		identity, ok := c.entries[strings.TrimSpace(plugins[index].ID)]
		if ok {
			applyPluginIdentity(&plugins[index], identity)
		}
	}
}

func (c *pluginIdentityCache) refresh(ctx context.Context, client *management.Client) {
	c.fetching.Lock()
	defer c.fetching.Unlock()
	c.mu.Lock()
	isRecent := !c.lastAttempt.IsZero() && c.now().Sub(c.lastAttempt) < pluginIdentityRetryInterval
	c.mu.Unlock()
	if isRecent {
		return
	}
	fetchCtx, cancel := context.WithTimeout(ctx, pluginIdentityFetchTimeout)
	defer cancel()
	store, err := client.PluginStore(fetchCtx)
	if err != nil {
		c.mu.Lock()
		c.lastAttempt = c.now()
		c.mu.Unlock()
		return
	}
	c.remember(store.Plugins)
}

// hasGaps reports whether any plugin is missing a name, author, version or logo.
func (c *pluginIdentityCache) hasGaps(plugins []management.PluginItem) bool {
	for _, plugin := range plugins {
		if pluginIdentityGap(plugin) {
			return true
		}
	}
	return false
}

// hasUnknown reports whether a plugin has a gap its cached identity cannot fill: no entry at
// all, or an entry that lacks the very field the plugin is missing. Either is worth another
// store read once the retry interval has passed, since a registry may since have added it.
func (c *pluginIdentityCache) hasUnknown(plugins []management.PluginItem) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, plugin := range plugins {
		if !pluginIdentityGap(plugin) {
			continue
		}
		identity, ok := c.entries[strings.TrimSpace(plugin.ID)]
		if !ok || !pluginIdentityCloses(plugin, identity) {
			return true
		}
	}
	return false
}

func pluginIdentityGap(plugin management.PluginItem) bool {
	if strings.TrimSpace(plugin.ID) == "" {
		return false
	}
	return !pluginIdentityCloses(plugin, pluginIdentity{})
}

// pluginIdentityCloses reports whether every field the plugin left empty is supplied by the
// identity. With an empty identity it answers whether the plugin has no gap at all.
func pluginIdentityCloses(plugin management.PluginItem, identity pluginIdentity) bool {
	var name, author, version string
	if plugin.Metadata != nil {
		name = strings.TrimSpace(plugin.Metadata.Name)
		author = strings.TrimSpace(plugin.Metadata.Author)
		version = strings.TrimSpace(plugin.Metadata.Version)
	}
	return (name != "" || identity.Name != "") &&
		(author != "" || identity.Author != "") &&
		(version != "" || identity.Version != "") &&
		(pluginLogoURL(plugin) != "" || identity.Logo != "")
}

// applyPluginIdentity fills only the fields the plugin left empty: what a loaded plugin
// registers about itself is the authority, and the store is the fallback.
func applyPluginIdentity(plugin *management.PluginItem, identity pluginIdentity) {
	if plugin.Metadata == nil {
		if identity.Name == "" && identity.Author == "" && identity.Version == "" && identity.Logo == "" {
			return
		}
		plugin.Metadata = &management.PluginMetadata{}
	}
	if strings.TrimSpace(plugin.Metadata.Name) == "" {
		plugin.Metadata.Name = identity.Name
	}
	if strings.TrimSpace(plugin.Metadata.Author) == "" {
		plugin.Metadata.Author = identity.Author
	}
	if strings.TrimSpace(plugin.Metadata.Version) == "" {
		plugin.Metadata.Version = identity.Version
	}
	if pluginLogoURL(*plugin) == "" && identity.Logo != "" {
		plugin.Logo = identity.Logo
	}
}
