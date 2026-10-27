package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/exchangerate"
)

// These are the complete public projection, not Frankfurter's native response.
type exchangeRateDTO struct {
	Currency string  `json:"currency"`
	Rate     float64 `json:"rate"`
	Date     string  `json:"date"`
}
type exchangeRatesDTO struct {
	BaseCurrency         string            `json:"base_currency"`
	Source               string            `json:"source"`
	RefreshIntervalHours int               `json:"refresh_interval_hours"`
	Rates                []exchangeRateDTO `json:"rates"`
	UpdatedAtMS          int64             `json:"updated_at_ms"`
	AttemptedAtMS        int64             `json:"attempted_at_ms"`
	NextRefreshAtMS      int64             `json:"next_refresh_at_ms"`
	LastError            string            `json:"last_error"`
}

func projectExchangeRates(snapshot exchangerate.Snapshot) exchangeRatesDTO {
	result := exchangeRatesDTO{
		BaseCurrency:         "USD",
		Source:               exchangerate.Source,
		RefreshIntervalHours: int(exchangerate.RefreshInterval / time.Hour),
		Rates:                make([]exchangeRateDTO, 0, len(snapshot.Rates)),
		UpdatedAtMS:          snapshot.UpdatedAtMS,
		AttemptedAtMS:        snapshot.AttemptedAtMS,
		LastError:            snapshot.LastError,
	}
	if snapshot.AttemptedAtMS > 0 {
		result.NextRefreshAtMS = snapshot.AttemptedAtMS + exchangerate.RefreshInterval.Milliseconds()
	}
	for _, rate := range snapshot.Rates {
		result.Rates = append(result.Rates, exchangeRateDTO{Currency: rate.Currency, Rate: rate.Rate, Date: rate.Date})
	}
	return result
}

func (h *Handler) listExchangeRates(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	snapshot, err := h.repo.ReadExchangeRates(ctx)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, projectExchangeRates(snapshot))
}

func (h *Handler) refreshExchangeRates(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.exchangeRates == nil {
		writeError(writer, http.StatusServiceUnavailable, "exchange_rates_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
	defer cancel()
	snapshot, err := h.exchangeRates.Refresh(ctx)
	if err != nil {
		switch {
		case errors.Is(err, exchangerate.ErrRefreshRunning):
			writeError(writer, http.StatusConflict, exchangerate.ErrRefreshRunning.Error())
		case errors.Is(err, exchangerate.ErrFetchFailed):
			writeError(writer, http.StatusBadGateway, exchangerate.ErrFetchFailed.Error())
		case errors.Is(err, context.Canceled):
			return
		default:
			writeInternalError(writer, err)
		}
		return
	}
	writeJSON(writer, http.StatusOK, projectExchangeRates(snapshot))
}

func (h *Handler) SetExchangeRates(service *exchangerate.Service) { h.exchangeRates = service }
