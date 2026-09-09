package management

import (
	"reflect"
	"testing"
)

// These mirror CPA's own semantics for disabling config API-key credentials:
// the marker is "*" inside excluded-models, and operator-defined patterns must
// survive a disable/enable round trip untouched.
func TestSetExcludedAll(t *testing.T) {
	if got := SetExcludedAll([]string{"gpt-5"}, true); !reflect.DeepEqual(got, []string{"gpt-5", ExcludedAllPattern}) {
		t.Fatalf("disable kept patterns wrong: %#v", got)
	}
	if got := SetExcludedAll([]string{"gpt-5", ExcludedAllPattern}, false); !reflect.DeepEqual(got, []string{"gpt-5"}) {
		t.Fatalf("enable must drop only the marker: %#v", got)
	}
	if got := SetExcludedAll([]string{"  *  "}, true); !reflect.DeepEqual(got, []string{"  *  "}) {
		t.Fatalf("disable must be idempotent, got %#v", got)
	}
	if got := SetExcludedAll(nil, false); got != nil {
		t.Fatalf("enable on an empty list must stay nil, got %#v", got)
	}
}

func TestIsExcludedAll(t *testing.T) {
	if !IsExcludedAll([]string{"custom-*", ExcludedAllPattern}) {
		t.Fatal("marker must count as disabled")
	}
	if IsExcludedAll([]string{"custom-*"}) {
		t.Fatal("custom exclusions alone are not a disable")
	}
	if IsExcludedAll(nil) {
		t.Fatal("empty list is not disabled")
	}
}
