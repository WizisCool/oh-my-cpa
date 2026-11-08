package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

const warmupTaskPrefix = "task/"

func warmupTaskTarget(taskID string) string {
	return warmupTaskPrefix + strings.TrimSpace(taskID)
}

func warmupOutcomeStatus(outcome string) string {
	switch outcome {
	case "ok":
		return "activated"
	case "failed":
		return "failed"
	case "running":
		return "executing"
	default:
		return "uncertain"
	}
}

func (repository *Repository) ListWarmupTasks(ctx context.Context, instance string) ([]warmup.Task, error) {
	rows, err := repository.SQL().QueryContext(ctx,
		`SELECT document_json FROM credential_warmup_policies WHERE instance_id=? AND scope='credential' AND target LIKE 'task/%' ORDER BY updated_at_ms ASC, target ASC`,
		instance,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]warmup.Task, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var task warmup.Task
		if json.Unmarshal([]byte(raw), &task) == nil && task.ID != "" {
			tasks = append(tasks, task)
		}
	}
	slices.SortFunc(tasks, func(a, b warmup.Task) int {
		if a.CreatedAt != b.CreatedAt {
			return strings.Compare(a.CreatedAt, b.CreatedAt)
		}
		return strings.Compare(a.ID, b.ID)
	})
	return tasks, rows.Err()
}

func (repository *Repository) ReadWarmupTask(ctx context.Context, instance, taskID string) (*warmup.Task, error) {
	var raw string
	err := repository.SQL().QueryRowContext(ctx,
		`SELECT document_json FROM credential_warmup_policies WHERE instance_id=? AND scope='credential' AND target=?`,
		instance, warmupTaskTarget(taskID),
	).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var task warmup.Task
	if err := json.Unmarshal([]byte(raw), &task); err != nil {
		return nil, err
	}
	return &task, nil
}

func (repository *Repository) WriteWarmupTask(ctx context.Context, instance string, task warmup.Task, nowMS int64) error {
	raw, err := json.Marshal(task)
	if err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx,
		`INSERT INTO credential_warmup_policies(instance_id,scope,target,document_json,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,scope,target) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`,
		instance, "credential", warmupTaskTarget(task.ID), string(raw), nowMS,
	)
	return err
}

func (repository *Repository) DeleteWarmupTask(ctx context.Context, instance, taskID string) error {
	target := warmupTaskTarget(taskID)
	tx, err := repository.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_warmup_policies WHERE instance_id=? AND scope='credential' AND target=?`, instance, target); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_warmup_state WHERE instance_id=? AND auth_index=?`, instance, target); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_warmup_runs WHERE instance_id=? AND auth_index=?`, instance, target); err != nil {
		return err
	}
	return tx.Commit()
}

func (repository *Repository) ReadWarmupMarks(ctx context.Context, instance, taskID string) (warmup.TaskMarks, error) {
	var raw string
	err := repository.SQL().QueryRowContext(ctx,
		`SELECT document_json FROM credential_warmup_state WHERE instance_id=? AND auth_index=?`,
		instance, warmupTaskTarget(taskID),
	).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return warmup.TaskMarks{}, nil
	}
	if err != nil {
		return warmup.TaskMarks{}, err
	}
	var marks warmup.TaskMarks
	if err := json.Unmarshal([]byte(raw), &marks); err != nil {
		return warmup.TaskMarks{}, err
	}
	return marks, nil
}

func (repository *Repository) ListWarmupMarks(ctx context.Context, instance string) (map[string]warmup.TaskMarks, error) {
	rows, err := repository.SQL().QueryContext(ctx,
		`SELECT auth_index, document_json FROM credential_warmup_state WHERE instance_id=? AND auth_index LIKE 'task/%'`,
		instance,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]warmup.TaskMarks)
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return nil, err
		}
		taskID := strings.TrimPrefix(key, warmupTaskPrefix)
		var marks warmup.TaskMarks
		if taskID != "" && json.Unmarshal([]byte(raw), &marks) == nil {
			out[taskID] = marks
		}
	}
	return out, rows.Err()
}

func (repository *Repository) WriteWarmupMarks(ctx context.Context, instance, taskID string, marks warmup.TaskMarks, nowMS int64) error {
	if len(marks.ResetKeys) > warmup.MAX_RESET_KEYS {
		marks.ResetKeys = marks.ResetKeys[len(marks.ResetKeys)-warmup.MAX_RESET_KEYS:]
	}
	raw, err := json.Marshal(marks)
	if err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx,
		`INSERT INTO credential_warmup_state(instance_id,auth_index,document_json,updated_at_ms) VALUES(?,?,?,?) ON CONFLICT(instance_id,auth_index) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`,
		instance, warmupTaskTarget(taskID), string(raw), nowMS,
	)
	return err
}

func (repository *Repository) ListWarmupRuns(ctx context.Context, instance string) ([]warmup.Run, error) {
	rows, err := repository.SQL().QueryContext(ctx,
		`SELECT document_json FROM credential_warmup_runs WHERE instance_id=? AND auth_index LIKE 'task/%' ORDER BY updated_at_ms DESC, rowid DESC LIMIT 200`,
		instance,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := make([]warmup.Run, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var run warmup.Run
		if json.Unmarshal([]byte(raw), &run) == nil && run.ID != "" && run.TaskID != "" {
			runs = append(runs, run)
		}
	}
	return runs, rows.Err()
}

func (repository *Repository) WriteWarmupRun(ctx context.Context, instance string, run warmup.Run) error {
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	updatedAtMS := int64(0)
	if t, ok := warmup.ParseISO(run.At); ok {
		updatedAtMS = t.UnixMilli()
	}
	target := warmupTaskTarget(run.TaskID)
	if _, err := repository.SQL().ExecContext(ctx,
		`INSERT INTO credential_warmup_runs(instance_id,auth_index,request_id,document_json,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,auth_index,request_id) DO UPDATE SET document_json=excluded.document_json,updated_at_ms=excluded.updated_at_ms`,
		instance, target, run.ID, string(raw), updatedAtMS,
	); err != nil {
		return err
	}
	_, err = repository.SQL().ExecContext(ctx,
		`DELETE FROM credential_warmup_runs WHERE instance_id=? AND auth_index=? AND request_id NOT IN (SELECT request_id FROM credential_warmup_runs WHERE instance_id=? AND auth_index=? ORDER BY updated_at_ms DESC, rowid DESC LIMIT ?)`,
		instance, target, instance, target, warmup.MAX_RUNS_PER_TASK,
	)
	return err
}

func (repository *Repository) RecoverWarmupRuns(ctx context.Context, instance string) error {
	rows, err := repository.SQL().QueryContext(ctx,
		`SELECT document_json FROM credential_warmup_runs WHERE instance_id=? AND auth_index LIKE 'task/%'`,
		instance,
	)
	if err != nil {
		return err
	}
	var running []warmup.Run
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			_ = rows.Close()
			return err
		}
		var run warmup.Run
		if json.Unmarshal([]byte(raw), &run) == nil && run.ID != "" && run.TaskID != "" && run.Outcome == "running" {
			running = append(running, run)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, run := range running {
		run.Outcome = "unknown"
		if run.Message == "" {
			run.Message = "interrupted_by_restart"
		}
		if err := repository.WriteWarmupRun(ctx, instance, run); err != nil {
			return err
		}
	}
	return nil
}
