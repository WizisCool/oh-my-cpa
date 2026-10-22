package repository

import (
	"database/sql/driver"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"modernc.org/sqlite"
)

const RESOLVED_SERVICE_TIER_SQL = `usage_service_tier(e.provider, e.executor_type, e.response_service_tier, e.service_tier, e.effective_service_tier)`

func init() {
	// Filtering and facets must use the same provider evidence as ingestion
	// and API projections, including for records stored before tier snapshots.
	sqlite.MustRegisterDeterministicScalarFunction("usage_service_tier", 5,
		func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			values := [5]string{}
			for index, value := range args {
				var isText bool
				values[index], isText = value.(string)
				if !isText {
					return nil, fmt.Errorf("usage_service_tier: argument %d must be text", index)
				}
			}
			tier, _ := pricing.ResolveServiceTier(values[0], values[1], values[2], values[3], values[4])
			return tier, nil
		})
}
