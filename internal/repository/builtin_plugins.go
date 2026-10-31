package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
)

var ErrBuiltinPolicyConflict = errors.New("builtin policy revision changed")
var ErrBuiltinBindingChanged = errors.New("builtin gateway binding changed")

func NormalizeGatewayURL(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("invalid CPA gateway address")
	}
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	parsed.Host = host
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed.String(), nil
}
func BuiltinGatewayID(instance domain.CPAInstance) string {
	address, _ := NormalizeGatewayURL(instance.BaseURL)
	sum := sha256.Sum256([]byte(address))
	return hex.EncodeToString(sum[:])
}

type BuiltinPolicy struct {
	Enabled         bool
	Revision        int64
	GatewayID       string
	LastReconcileAt string
	Overrides       map[string]BuiltinPluginPolicy
	Operations      map[string]BuiltinOperation
}
type BuiltinPluginPolicy struct {
	State string
}
type BuiltinOperation struct {
	Version   string
	State     string
	Reason    string
	UpdatedAt string
}

func (r *Repository) LoadBuiltinCatalog(ctx context.Context) ([]byte, []pluginregistry.Plugin, error) {
	var snapshot []byte
	err := r.SQL().QueryRowContext(ctx, `SELECT document FROM builtin_catalog WHERE id=1`).Scan(&snapshot)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT document FROM builtin_releases ORDER BY plugin_id,version`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	plugins := []pluginregistry.Plugin{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, nil, err
		}
		var plugin pluginregistry.Plugin
		if err := json.Unmarshal(raw, &plugin); err != nil {
			return nil, nil, err
		}
		plugins = append(plugins, plugin)
	}
	return snapshot, plugins, rows.Err()
}
func (r *Repository) SaveBuiltinCatalog(ctx context.Context, snapshot []byte, manifest pluginregistry.Manifest) error {
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, plugin := range manifest.Plugins {
		rows, err := tx.QueryContext(ctx, `SELECT version FROM builtin_releases WHERE plugin_id=?`, plugin.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var previous string
			if err := rows.Scan(&previous); err != nil {
				rows.Close()
				return err
			}
			if comparison, comparable := pluginregistry.CompareVersions(plugin.Version, previous); !comparable || comparison < 0 {
				rows.Close()
				return pluginregistry.ErrReleaseDowngrade
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		releases := append([]pluginregistry.Version{{Version: plugin.Version, Install: plugin.Install}}, plugin.Versions...)
		for _, release := range releases {
			for _, artifact := range release.Install.Artifacts {
				var old string
				identity := pluginregistry.ArtifactIdentity(artifact)
				err = tx.QueryRowContext(ctx, `SELECT identity FROM builtin_artifacts WHERE plugin_id=? AND version=? AND platform=?`, plugin.ID, release.Version, artifact.GOOS+"/"+artifact.GOARCH).Scan(&old)
				if err == nil && old != identity {
					return pluginregistry.ErrImmutableArtifact
				}
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return err
				}
				if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO builtin_artifacts(plugin_id,version,platform,identity) VALUES(?,?,?,?)`, plugin.ID, release.Version, artifact.GOOS+"/"+artifact.GOARCH, identity); err != nil {
					return err
				}
			}
			historical := plugin
			historical.Version = release.Version
			historical.Install = release.Install
			historical.Versions = nil
			var previousDocument []byte
			readErr := tx.QueryRowContext(ctx, `SELECT document FROM builtin_releases WHERE plugin_id=? AND version=?`, plugin.ID, release.Version).Scan(&previousDocument)
			if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
				return readErr
			}
			if readErr == nil {
				var previous pluginregistry.Plugin
				if err := json.Unmarshal(previousDocument, &previous); err != nil {
					return err
				}
				seen := map[string]bool{}
				for _, artifact := range historical.Install.Artifacts {
					seen[artifact.GOOS+"/"+artifact.GOARCH] = true
				}
				for _, artifact := range previous.Install.Artifacts {
					if !seen[artifact.GOOS+"/"+artifact.GOARCH] {
						historical.Install.Artifacts = append(historical.Install.Artifacts, artifact)
					}
				}
			}
			raw, err := json.Marshal(historical)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO builtin_releases(plugin_id,version,document) VALUES(?,?,?) ON CONFLICT(plugin_id,version) DO UPDATE SET document=excluded.document`, plugin.ID, release.Version, raw); err != nil {
				return err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO builtin_catalog(id,document) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`, snapshot); err != nil {
		return err
	}
	return tx.Commit()
}
func (r *Repository) BuiltinPolicy(ctx context.Context, instance domain.CPAInstance) (BuiltinPolicy, error) {
	policy := BuiltinPolicy{Enabled: true, Revision: 1, GatewayID: BuiltinGatewayID(instance), Overrides: map[string]BuiltinPluginPolicy{}, Operations: map[string]BuiltinOperation{}}
	err := r.SQL().QueryRowContext(ctx, `SELECT enabled,revision,gateway_id,last_reconcile_at FROM builtin_policies WHERE instance_id=? AND generation=?`, instance.ID, instance.BindingGeneration).Scan(&policy.Enabled, &policy.Revision, &policy.GatewayID, &policy.LastReconcileAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return policy, err
	}
	if policy.GatewayID != BuiltinGatewayID(instance) {
		return policy, ErrBuiltinBindingChanged
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT plugin_id,state FROM builtin_plugin_policies WHERE instance_id=? AND generation=?`, instance.ID, instance.BindingGeneration)
	if err != nil {
		return policy, err
	}
	for rows.Next() {
		var id string
		var value BuiltinPluginPolicy
		if err := rows.Scan(&id, &value.State); err != nil {
			rows.Close()
			return policy, err
		}
		policy.Overrides[id] = value
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return policy, err
	}
	rows.Close()
	rows, err = r.SQL().QueryContext(ctx, `SELECT plugin_id,version,state,reason,updated_at FROM builtin_operations WHERE instance_id=? AND generation=?`, instance.ID, instance.BindingGeneration)
	if err != nil {
		return policy, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var value BuiltinOperation
		if err := rows.Scan(&id, &value.Version, &value.State, &value.Reason, &value.UpdatedAt); err != nil {
			return policy, err
		}
		policy.Operations[id] = value
	}
	return policy, rows.Err()
}

// SaveBuiltinPolicy checks the binding and optimistic revision in the same SQLite
// transaction; a reused "default" instance cannot inherit another CPA's switches.
func (r *Repository) SaveBuiltinPolicy(ctx context.Context, instance domain.CPAInstance, policy BuiltinPolicy, expected int64, pluginID string, override *BuiltinPluginPolicy) error {
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var generation int64
	var address string
	if err := tx.QueryRowContext(ctx, `SELECT binding_generation,base_url FROM cpa_instances WHERE id=?`, instance.ID).Scan(&generation, &address); err != nil {
		return err
	}
	if generation != instance.BindingGeneration || address != instance.BaseURL {
		return ErrBuiltinBindingChanged
	}
	var revision int64
	err = tx.QueryRowContext(ctx, `SELECT revision FROM builtin_policies WHERE instance_id=? AND generation=?`, instance.ID, generation).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		revision = 1
	} else if err != nil {
		return err
	}
	if revision != expected {
		return ErrBuiltinPolicyConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO builtin_policies(instance_id,generation,gateway_id,enabled,consent,revision) VALUES(?,?,?,?,1,?) ON CONFLICT(instance_id,generation) DO UPDATE SET enabled=excluded.enabled,consent=1,revision=excluded.revision`, instance.ID, generation, BuiltinGatewayID(instance), policy.Enabled, revision+1); err != nil {
		return err
	}
	if override != nil {
		if _, err = tx.ExecContext(ctx, `INSERT INTO builtin_plugin_policies(instance_id,generation,plugin_id,state,pinned_version) VALUES(?,?,?,?,'') ON CONFLICT(instance_id,generation,plugin_id) DO UPDATE SET state=excluded.state,pinned_version=''`, instance.ID, generation, pluginID, override.State); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (r *Repository) SaveBuiltinOperation(ctx context.Context, instance domain.CPAInstance, id string, operation BuiltinOperation) error {
	result, err := r.SQL().ExecContext(ctx, `INSERT INTO builtin_operations(instance_id,generation,plugin_id,version,state,reason,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cpa_instances WHERE id=? AND binding_generation=? AND base_url=?) ON CONFLICT(instance_id,generation,plugin_id) DO UPDATE SET version=excluded.version,state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at`, instance.ID, instance.BindingGeneration, id, operation.Version, operation.State, operation.Reason, time.Now().UTC().Format(time.RFC3339), instance.ID, instance.BindingGeneration, instance.BaseURL)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrBuiltinBindingChanged
	}
	return nil
}
func (r *Repository) MarkBuiltinReconciled(ctx context.Context, instance domain.CPAInstance) error {
	result, err := r.SQL().ExecContext(ctx, `INSERT INTO builtin_policies(instance_id,generation,gateway_id,enabled,consent,revision,last_reconcile_at) SELECT ?,?,?,1,1,1,? WHERE EXISTS(SELECT 1 FROM cpa_instances WHERE id=? AND binding_generation=? AND base_url=?) ON CONFLICT(instance_id,generation) DO UPDATE SET last_reconcile_at=excluded.last_reconcile_at`, instance.ID, instance.BindingGeneration, BuiltinGatewayID(instance), time.Now().UTC().Format(time.RFC3339Nano), instance.ID, instance.BindingGeneration, instance.BaseURL)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrBuiltinBindingChanged
	}
	return nil
}
func (r *Repository) CheckBuiltinBinding(ctx context.Context, expected domain.CPAInstance) error {
	current, err := r.GetInstance(ctx, expected.ID)
	if err != nil {
		return err
	}
	if current.BindingGeneration != expected.BindingGeneration || BuiltinGatewayID(current) != BuiltinGatewayID(expected) {
		return fmt.Errorf("%w", ErrBuiltinBindingChanged)
	}
	return nil
}
