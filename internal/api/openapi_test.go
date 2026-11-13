package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type swaggerDocument struct {
	Swagger     string                                `json:"swagger"`
	BasePath    string                                `json:"basePath"`
	Paths       map[string]map[string]json.RawMessage `json:"paths"`
	Definitions map[string]json.RawMessage            `json:"definitions"`
}

type swaggerOperation struct {
	Summary   string                     `json:"summary"`
	Responses map[string]json.RawMessage `json:"responses"`
}

var chiParamConstraintPattern = regexp.MustCompile(`\{([A-Za-z0-9_]+):[^}]+\}`)

func normalizeAPIRouteForSwagger(basePath, route string) (string, bool) {
	path := stripBasePath(basePath, route)
	if !strings.HasPrefix(path, "/api/") && path != "/api" {
		return "", false
	}
	relative := strings.TrimPrefix(path, "/api")
	if relative == "" {
		relative = "/"
	}
	relative = chiParamConstraintPattern.ReplaceAllString(relative, `{$1}`)
	if strings.HasSuffix(relative, "/*") {
		relative = strings.TrimSuffix(relative, "*") + "{path}"
	} else if strings.HasSuffix(relative, "*") {
		relative = strings.TrimSuffix(relative, "*") + "{path}"
	}
	return relative, true
}

func TestOpenAPIRouteCoverage(t *testing.T) {
	specPath := filepath.Join("..", "..", "docs", "openapi", "swagger.json")
	raw, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatalf("read %s: %v (run pnpm openapi:generate)", specPath, err)
	}

	var doc swaggerDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", specPath, err)
	}
	if doc.Swagger != "2.0" {
		t.Fatalf("expected swagger 2.0, got %q", doc.Swagger)
	}
	if doc.BasePath != "/api" {
		t.Fatalf("expected basePath /api, got %q", doc.BasePath)
	}

	const basePath = "/omc"
	handler := demoHandler(t, basePath)
	routes := handler.routes()

	registered := make(map[string]struct{})
	if err := chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		normalized, isAPI := normalizeAPIRouteForSwagger(basePath, route)
		if !isAPI {
			return nil
		}
		registered[strings.ToUpper(method)+" "+normalized] = struct{}{}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(registered) == 0 {
		t.Fatal("no /api routes walked")
	}

	documented := make(map[string]struct{})
	for path, methods := range doc.Paths {
		for method, opRaw := range methods {
			upper := strings.ToUpper(method)
			switch upper {
			case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
			default:
				continue
			}
			var op swaggerOperation
			if err := json.Unmarshal(opRaw, &op); err != nil {
				t.Fatalf("parse operation %s %s: %v", upper, path, err)
			}
			if strings.TrimSpace(op.Summary) == "" {
				t.Errorf("OpenAPI operation %s %s is missing a summary", upper, path)
			}
			if len(op.Responses) == 0 {
				t.Errorf("OpenAPI operation %s %s has no responses", upper, path)
			}
			documented[upper+" "+path] = struct{}{}
		}
	}

	var missing []string
	for routeKey := range registered {
		if _, ok := documented[routeKey]; !ok {
			missing = append(missing, routeKey)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("%d registered /api route(s) are missing swaggo @Router annotations (add annotations and run `pnpm openapi:generate`):\n  %s",
			len(missing), strings.Join(missing, "\n  "))
	}

	var stale []string
	for docKey := range documented {
		if _, ok := registered[docKey]; !ok {
			stale = append(stale, docKey)
		}
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Fatalf("%d OpenAPI operation(s) do not match any registered route (update @Router annotations and run `pnpm openapi:generate`):\n  %s",
			len(stale), strings.Join(stale, "\n  "))
	}

	var missingRefs []string
	verifyOpenAPIRefs(doc.Paths, doc.Definitions, &missingRefs)
	verifyOpenAPIRefs(doc.Definitions, doc.Definitions, &missingRefs)
	if len(missingRefs) > 0 {
		sort.Strings(missingRefs)
		t.Fatalf("unresolved OpenAPI $ref target(s):\n  %s", strings.Join(missingRefs, "\n  "))
	}
}

func verifyOpenAPIRefs(node any, definitions map[string]json.RawMessage, missing *[]string) {
	switch typed := node.(type) {
	case map[string]json.RawMessage:
		for _, raw := range typed {
			var child any
			if err := json.Unmarshal(raw, &child); err == nil {
				verifyOpenAPIRefs(child, definitions, missing)
			}
		}
	case map[string]any:
		if ref, ok := typed["$ref"].(string); ok {
			const prefix = "#/definitions/"
			if !strings.HasPrefix(ref, prefix) {
				*missing = append(*missing, ref)
			} else if _, exists := definitions[strings.TrimPrefix(ref, prefix)]; !exists {
				*missing = append(*missing, ref)
			}
		}
		for _, child := range typed {
			verifyOpenAPIRefs(child, definitions, missing)
		}
	case []any:
		for _, child := range typed {
			verifyOpenAPIRefs(child, definitions, missing)
		}
	}
}

func TestOpenAPISpecFreshness(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping swag regeneration check in -short mode; covered by pnpm check:openapi")
	}
	repoRoot := filepath.Join("..", "..")
	committedPath := filepath.Join(repoRoot, "docs", "openapi", "swagger.json")
	committedRaw, err := os.ReadFile(committedPath)
	if err != nil {
		t.Fatalf("read %s: %v", committedPath, err)
	}

	tempDir := t.TempDir()
	cmd := exec.Command(
		"go", "tool", "swag", "init",
		"--generalInfo", "swagger.go",
		"--dir", "internal/api,internal/domain",
		"--parseInternal",
		"--parseDependencyLevel", "1",
		"--propertyStrategy", "snakecase",
		"--output", tempDir,
		"--outputTypes", "json",
		"--quiet",
	)
	cmd.Dir = repoRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go tool swag init failed: %v\n%s", err, output)
	}

	generatedRaw, err := os.ReadFile(filepath.Join(tempDir, "swagger.json"))
	if err != nil {
		t.Fatalf("read generated swagger.json: %v", err)
	}

	var committedObj, generatedObj any
	if err := json.Unmarshal(committedRaw, &committedObj); err != nil {
		t.Fatalf("parse committed swagger.json: %v", err)
	}
	if err := json.Unmarshal(generatedRaw, &generatedObj); err != nil {
		t.Fatalf("parse generated swagger.json: %v", err)
	}
	if !reflect.DeepEqual(committedObj, generatedObj) {
		t.Fatalf("docs/openapi/swagger.json is out of date; run `pnpm openapi:generate` and commit the updated file")
	}
}
