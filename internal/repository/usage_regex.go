package repository

import (
	"database/sql/driver"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"modernc.org/sqlite"
)

// MaxUsageRegexLength bounds a request filter's pattern. RE2 matches in time
// linear in the input, so the bound is on what a compiled program costs to
// build and hold, not on backtracking.
const MaxUsageRegexLength = 256

// usageRegexColumns are the request-record fields a pattern may be matched
// against, by the name the filter carries. They are the free-form identities a
// reader narrows by shape - a model family, a client product, a route - and the
// set is closed so the name can never reach the statement as text. The source and
// the caller key are absent: both are stored as fingerprints, which no pattern a
// reader would write can describe.
var usageRegexColumns = map[string]string{
	"model":          "e.model",
	"model_alias":    "e.model_alias",
	"response_model": "e.response_model",
	"provider":       "e.provider",
	"endpoint":       "e.endpoint",
	"ua":             "e.user_agent",
	"request_id":     "e.request_id",
}

// UsageRegexFields lists the field names a pattern filter accepts, in the order
// a caller should present them.
func UsageRegexFields() []string {
	return []string{"model", "model_alias", "response_model", "provider", "endpoint", "ua", "request_id"}
}

// ValidateUsageRegex reports why a field and pattern cannot be used as a filter.
// An empty pattern is no filter at all and is valid whatever the field says.
func ValidateUsageRegex(field, pattern string) error {
	if pattern == "" {
		return nil
	}
	if _, known := usageRegexColumns[field]; !known {
		return fmt.Errorf("%w: regex_field must be one of %s", ErrUsageFilterInvalid, strings.Join(UsageRegexFields(), ", "))
	}
	if len(pattern) > MaxUsageRegexLength {
		return fmt.Errorf("%w: regex must be at most %d characters", ErrUsageFilterInvalid, MaxUsageRegexLength)
	}
	if _, err := regexp.Compile(pattern); err != nil {
		return fmt.Errorf("%w: regex is not a valid RE2 pattern: %s", ErrUsageFilterInvalid, strings.TrimPrefix(err.Error(), "error parsing regexp: "))
	}
	return nil
}

// usageEventRegexClause renders the pattern filter. A missing value is matched as
// the empty string, so `^$` finds the records that carry none.
func usageEventRegexClause(field, pattern string) (string, []any, error) {
	if pattern == "" {
		return "", nil, nil
	}
	if err := ValidateUsageRegex(field, pattern); err != nil {
		return "", nil, err
	}
	return "COALESCE(" + usageRegexColumns[field] + ", '') REGEXP ?", []any{pattern}, nil
}

// compiledUsageRegexes holds the programs of the patterns in use. SQLite calls the
// function once per candidate row, and compiling per row would dominate the scan.
// The cache is emptied when it fills rather than tracking recency: patterns are
// typed by a person, a handful are live at once, and recompiling one is cheap.
var compiledUsageRegexes = struct {
	sync.Mutex
	programs map[string]*regexp.Regexp
}{programs: make(map[string]*regexp.Regexp)}

const maxCompiledUsageRegexes = 64

func compileUsageRegex(pattern string) (*regexp.Regexp, error) {
	compiledUsageRegexes.Lock()
	defer compiledUsageRegexes.Unlock()
	if program, cached := compiledUsageRegexes.programs[pattern]; cached {
		return program, nil
	}
	program, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	if len(compiledUsageRegexes.programs) >= maxCompiledUsageRegexes {
		clear(compiledUsageRegexes.programs)
	}
	compiledUsageRegexes.programs[pattern] = program
	return program, nil
}

// SQLite has the REGEXP operator but no implementation behind it: `X REGEXP Y`
// calls a user function regexp(Y, X). Go's engine is RE2, so a pattern cannot
// make a scan take longer than its input is long - which is why a pattern typed
// into the console may be run against every record in a window.
func init() {
	sqlite.MustRegisterDeterministicScalarFunction("regexp", 2,
		func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			pattern, isText := args[0].(string)
			if !isText || len(pattern) > MaxUsageRegexLength {
				return nil, fmt.Errorf("regexp: the pattern must be text of at most %d characters", MaxUsageRegexLength)
			}
			program, err := compileUsageRegex(pattern)
			if err != nil {
				return nil, err
			}
			switch subject := args[1].(type) {
			case string:
				return program.MatchString(subject), nil
			case []byte:
				return program.Match(subject), nil
			case nil:
				return false, nil
			default:
				return program.MatchString(fmt.Sprint(subject)), nil
			}
		})
}
