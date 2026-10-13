package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

func (repository *Repository) ReadWarmupPolicy(ctx context.Context, instance, scope, target string) (warmup.Policy, bool, error) {
	var raw string
	err := repository.SQL().QueryRowContext(ctx, `SELECT document_json FROM credential_warmup_policies WHERE instance_id=? AND scope=? AND target=?`, instance, scope, target).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return warmup.DefaultPolicy(), false, nil
	}
	if err != nil {
		return warmup.Policy{}, false, err
	}
	var policy warmup.Policy
	if err = json.Unmarshal([]byte(raw), &policy); err != nil {
		return policy, true, err
	}
	return policy, true, policy.Validate()
}
func (repository *Repository) WriteWarmupPolicy(ctx context.Context, instance, scope, target string, policy *warmup.Policy, nowMS int64) error {
	if policy == nil {
		_, err := repository.SQL().ExecContext(ctx, `DELETE FROM credential_warmup_policies WHERE instance_id=? AND scope=? AND target=?`, instance, scope, target)
		return err
	}
	if err := policy.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx, `INSERT INTO credential_warmup_policies(instance_id,scope,target,document_json,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,scope,target) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`, instance, scope, target, string(raw), nowMS)
	return err
}
func (repository *Repository) ReadWarmupState(ctx context.Context, instance, authIndex string) (warmup.State, error) {
	var raw string
	var state warmup.State
	err := repository.SQL().QueryRowContext(ctx, `SELECT document_json FROM credential_warmup_state WHERE instance_id=? AND auth_index=?`, instance, authIndex).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	err = json.Unmarshal([]byte(raw), &state)
	return state, err
}
func (repository *Repository) WriteWarmupState(ctx context.Context, instance, authIndex string, state warmup.State, nowMS int64) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx, `INSERT INTO credential_warmup_state(instance_id,auth_index,document_json,updated_at_ms) VALUES(?,?,?,?) ON CONFLICT(instance_id,auth_index) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`, instance, authIndex, string(raw), nowMS)
	return err
}
func (repository *Repository) ReadWarmupRun(ctx context.Context, instance, authIndex, requestID string) (*warmup.Result, error) {
	var raw string
	err := repository.SQL().QueryRowContext(ctx, `SELECT document_json FROM credential_warmup_runs WHERE instance_id=? AND auth_index=? AND request_id=?`, instance, authIndex, requestID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var result warmup.Result
	err = json.Unmarshal([]byte(raw), &result)
	return &result, err
}
func (repository *Repository) WriteWarmupRun(ctx context.Context, instance, authIndex string, result warmup.Result) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx, `INSERT INTO credential_warmup_runs(instance_id,auth_index,request_id,document_json,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,auth_index,request_id) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`, instance, authIndex, result.RequestID, string(raw), result.StartedAtMS)
	if err != nil {
		return err
	}
	// Retained receipts stay bounded; cycle suppression lives separately in state.
	_, err = repository.SQL().ExecContext(ctx, `DELETE FROM credential_warmup_runs WHERE instance_id=? AND auth_index=? AND request_id NOT IN (SELECT request_id FROM credential_warmup_runs WHERE instance_id=? AND auth_index=? ORDER BY updated_at_ms DESC,rowid DESC LIMIT 100)`, instance, authIndex, instance, authIndex)
	return err
}
