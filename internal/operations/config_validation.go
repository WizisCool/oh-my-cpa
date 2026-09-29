package operations

import (
	"errors"
	"math"
	"strings"
)

func ValidateScalarValue(key string, value any) (any, error) {
	switch key {
	case "debug", "request_log", "logging_to_file", "usage_statistics_enabled", "ws_auth", "force_model_prefix":
		if b, ok := value.(bool); ok {
			return b, nil
		}
		return nil, errors.New("value must be a boolean for key " + key)

	case "proxy_url":
		if s, ok := value.(string); ok {
			return strings.TrimSpace(s), nil
		}
		return nil, errors.New("value must be a string for proxy_url")

	case "request_retry", "max_retry_interval", "max_retry_credentials", "logs_max_total_size_mb", "error_logs_max_files":
		switch num := value.(type) {
		case float64:
			if num < 0 || math.IsNaN(num) || math.IsInf(num, 0) || math.Trunc(num) != num || num > 9007199254740991 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return int64(num), nil
		case int64:
			if num < 0 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return num, nil
		case int:
			if num < 0 {
				return nil, errors.New("value must be non-negative for key " + key)
			}
			return int64(num), nil
		default:
			return nil, errors.New("value must be an integer for key " + key)
		}

	case "routing_strategy":
		if s, ok := value.(string); ok {
			if strategy, known := normalizeRoutingStrategy(s); known {
				return strategy, nil
			}
			return nil, errors.New("invalid routing strategy: must be round-robin, weighted-round-robin, or fill-first")
		}
		return nil, errors.New("value must be a string for routing_strategy")

	default:
		return nil, errors.New("unknown or unsupported config scalar key: " + key)
	}
}

// normalizeRoutingStrategy accepts the spellings CPA's own management handler
// accepts and returns the canonical one, so a value that passes here is one CPA
// runs rather than one it silently falls back from.
func normalizeRoutingStrategy(strategy string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(strategy)) {
	case "round-robin", "roundrobin", "rr":
		return "round-robin", true
	case "weighted-round-robin", "weightedroundrobin", "wrr":
		return "weighted-round-robin", true
	case "fill-first", "fillfirst", "ff":
		return "fill-first", true
	default:
		return "", false
	}
}
