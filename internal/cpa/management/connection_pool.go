package management

import (
	"bytes"
	"encoding/json"
	"reflect"
)

// ConnectionPoolConfig is a credential-scoped opt-in. A non-nil empty value
// enables CPA's defaults; nil inherits the group, or stays unpooled without one.
type ConnectionPoolConfig struct {
	Enabled             *bool   `json:"enabled,omitempty"`
	IdleConnTimeout     *string `json:"idle-conn-timeout,omitempty"`
	MaxIdleConnsPerHost *int    `json:"max-idle-conns-per-host,omitempty"`
	extra               wireExtras
	// Preserve explicit nulls in untouched inherited fields.
	nullFields wireExtras
}

type connectionPoolFields ConnectionPoolConfig

var connectionPoolModelledFields = modelledWireFields(reflect.TypeOf(connectionPoolFields{}))

func (p *ConnectionPoolConfig) UnmarshalJSON(data []byte) error {
	var fields connectionPoolFields
	extra, err := decodeWithExtras(data, &fields, connectionPoolModelledFields)
	if err != nil {
		return err
	}
	*p = ConnectionPoolConfig(fields)
	p.extra = extra
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for name, value := range raw {
		if connectionPoolModelledFields[name] && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			if p.nullFields == nil {
				p.nullFields = wireExtras{}
			}
			p.nullFields[name] = value
		}
	}
	return nil
}

func (p ConnectionPoolConfig) MarshalJSON() ([]byte, error) {
	if len(p.nullFields) == 0 {
		return encodeWithExtras(connectionPoolFields(p), p.extra)
	}
	extra := make(wireExtras, len(p.extra)+len(p.nullFields))
	for name, value := range p.extra {
		extra[name] = value
	}
	for name, value := range p.nullFields {
		extra[name] = value
	}
	return encodeWithExtras(connectionPoolFields(p), extra)
}

// MergeConnectionPools resolves only explicitly configured fields, never runtime
// defaults. It must keep an empty opt-in block and must not mutate either input.
func MergeConnectionPools(group, override *ConnectionPoolConfig) *ConnectionPoolConfig {
	if group == nil && override == nil {
		return nil
	}
	merged := ConnectionPoolConfig{}
	if group != nil {
		merged = *group
	}
	if override != nil {
		if override.Enabled != nil {
			merged.Enabled = override.Enabled
		}
		if override.IdleConnTimeout != nil && *override.IdleConnTimeout != "" {
			merged.IdleConnTimeout = override.IdleConnTimeout
		}
		if override.MaxIdleConnsPerHost != nil {
			merged.MaxIdleConnsPerHost = override.MaxIdleConnsPerHost
		}
	}
	return &merged
}

// PoolContext keeps raw ownership separate from the flattened effective value.
// Only handwritten API projections may cross the browser boundary.
type PoolContext struct {
	GroupName string
	GroupSize int
	Group     *ConnectionPoolConfig
	Override  *ConnectionPoolConfig
	Effective *ConnectionPoolConfig
}

type configKeyPool struct {
	group, override       *ConnectionPoolConfig
	rawGroup, rawOverride any
	hasGroup, hasOverride bool
	isGroupEdited         bool
	groupName             string
	groupSize             int
}

func readPool(value any) (*ConnectionPoolConfig, error) {
	if value == nil {
		return nil, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var pool ConnectionPoolConfig
	if err := json.Unmarshal(data, &pool); err != nil {
		return nil, err
	}
	return &pool, nil
}

func storedConfigKeyPool(group, key map[string]any) (*configKeyPool, error) {
	pool := &configKeyPool{}
	pool.rawGroup, pool.hasGroup = group["connection-pool"]
	pool.rawOverride, pool.hasOverride = key["connection-pool"]
	pool.groupName, _ = group["name"].(string)
	keys, _ := group["keys"].([]any)
	pool.groupSize = len(keys)
	var err error
	pool.group, err = readPool(pool.rawGroup)
	if err != nil {
		return nil, err
	}
	pool.override, err = readPool(pool.rawOverride)
	return pool, err
}

func (e ConfigAPIKey) ConnectionPoolContext() PoolContext {
	if e.pool == nil {
		return PoolContext{GroupSize: 1, Override: e.ConnectionPool, Effective: e.ConnectionPool}
	}
	return PoolContext{
		GroupName: e.pool.groupName, GroupSize: e.pool.groupSize,
		Group: e.pool.group, Override: e.pool.override,
		Effective: MergeConnectionPools(e.pool.group, e.pool.override),
	}
}

// EditConnectionPool distinguishes a group-default edit from a key override.
// Omitted edits never materialize an inherited field on the key.
func (e *ConfigAPIKey) EditConnectionPool(isGroup bool, value *ConnectionPoolConfig) error {
	context := e.ConnectionPoolContext()
	stored := context.Override
	if isGroup {
		stored = context.Group
	}
	value = ReplaceConnectionPoolSettings(stored, value)
	var raw any
	if value != nil {
		var err error
		raw, err = wireObject(value)
		if err != nil {
			return err
		}
	}
	pool := configKeyPool{override: e.ConnectionPool, groupSize: 1}
	if e.pool != nil {
		pool = *e.pool
	} else if e.ConnectionPool != nil {
		var err error
		pool.rawOverride, err = wireObject(e.ConnectionPool)
		if err != nil {
			return err
		}
		pool.hasOverride = true
	}
	if isGroup {
		pool.group, pool.rawGroup, pool.hasGroup, pool.isGroupEdited = value, raw, value != nil, true
	} else {
		pool.override, pool.rawOverride, pool.hasOverride = value, raw, value != nil
	}
	e.pool = &pool
	e.ConnectionPool = MergeConnectionPools(pool.group, pool.override)
	return nil
}

func (e ConfigAPIKey) writeKeyPool(key map[string]any) error {
	if e.pool != nil {
		if e.pool.hasOverride {
			key["connection-pool"] = e.pool.rawOverride
		}
		return nil
	}
	if e.ConnectionPool != nil {
		pool, err := wireObject(e.ConnectionPool)
		if err != nil {
			return err
		}
		key["connection-pool"] = pool
	}
	return nil
}

// mergePoolValues mirrors CPA's YAML merge, including null subfield inheritance.
// The stored objects remain untouched so an unrelated edit preserves their shape.
func mergePoolValues(group, override any) any {
	base, isBaseObject := group.(map[string]any)
	child, isChildObject := override.(map[string]any)
	if !isBaseObject || !isChildObject {
		return override
	}
	merged := make(map[string]any, len(base)+len(child))
	for name, value := range base {
		merged[name] = value
	}
	for name, value := range child {
		if value != nil {
			merged[name] = value
		}
	}
	return merged
}

// ReplaceConnectionPoolSettings changes known fields without discarding fields
// introduced by a newer CPA. Removing the entire block is an explicit operation.
func ReplaceConnectionPoolSettings(stored, edited *ConnectionPoolConfig) *ConnectionPoolConfig {
	if edited == nil {
		return nil
	}
	result := *edited
	if stored != nil {
		result.extra = stored.extra
	}
	return &result
}

// CopyConnectionPoolTo detaches a protocol conversion from the old group's
// identity while preserving its pool defaults and this key's explicit overrides.
func (e ConfigAPIKey) CopyConnectionPoolTo(target *ConfigAPIKey) {
	target.ConnectionPool = e.ConnectionPool
	if e.pool != nil {
		pool := *e.pool
		target.pool = &pool
	}
}

// ProviderRuntimeView retains CPA's normalized endpoint, models and behaviour
// while carrying pool ownership from storage. Only pool editing needs raw values;
// replacing the entire provider read with stored fields would regress implicit URLs.
func (e ConfigAPIKey) ProviderRuntimeView() ConfigAPIKey {
	if e.runtimeView == nil {
		return e
	}
	view := *e.runtimeView
	view.ConnectionPool, view.pool = e.ConnectionPool, e.pool
	return view
}

func (e OpenAICompatibility) ProviderRuntimeView() OpenAICompatibility {
	if e.runtimeView == nil {
		return e
	}
	view := *e.runtimeView
	view.ConnectionPool = e.ConnectionPool
	view.APIKeyEntries = append([]APIKeyEntry(nil), view.APIKeyEntries...)
	for i := range view.APIKeyEntries {
		for _, stored := range e.APIKeyEntries {
			if view.APIKeyEntries[i].APIKey == stored.APIKey {
				view.APIKeyEntries[i].ConnectionPool = stored.ConnectionPool
				break
			}
		}
	}
	return view
}
