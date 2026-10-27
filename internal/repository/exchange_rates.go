package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/exchangerate"
)

func (r *Repository) ReadExchangeRates(ctx context.Context) (exchangerate.Snapshot, error) {
	snapshot := exchangerate.Snapshot{Rates: []exchangerate.Rate{}}
	var raw string
	err := r.SQL().QueryRowContext(ctx, `SELECT rates_json, updated_at_ms, attempted_at_ms, last_error FROM exchange_rate_cache WHERE id=1`).Scan(&raw, &snapshot.UpdatedAtMS, &snapshot.AttemptedAtMS, &snapshot.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, fmt.Errorf("read exchange rate cache: %w", err)
	}
	if err := json.Unmarshal([]byte(raw), &snapshot.Rates); err != nil {
		return snapshot, fmt.Errorf("decode exchange rate cache: %w", err)
	}
	return snapshot, nil
}

func (r *Repository) SaveExchangeRates(ctx context.Context, snapshot exchangerate.Snapshot) error {
	raw, err := json.Marshal(snapshot.Rates)
	if err != nil {
		return err
	}
	_, err = r.SQL().ExecContext(ctx, `INSERT INTO exchange_rate_cache(id,rates_json,updated_at_ms,attempted_at_ms,last_error) VALUES(1,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET rates_json=excluded.rates_json,updated_at_ms=excluded.updated_at_ms,attempted_at_ms=excluded.attempted_at_ms,last_error=excluded.last_error`, string(raw), snapshot.UpdatedAtMS, snapshot.AttemptedAtMS, snapshot.LastError)
	return err
}
