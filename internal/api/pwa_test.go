package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
)

// publicConsoleDir is the committed console source the build copies into the embedded
// dist. The installable-app tests read it directly rather than through web.Dist:
// the embed is fixed when the Go test binary is compiled, and a checkout that has not
// run `pnpm build` must still be able to prove this contract. pwa.go reads the same
// root in production.
const publicConsoleDir = "../../web/public"

// consoleIndexFile is the entry document Vite transforms; it is a sibling of public/, not
// inside it, so the deep-link test reads it by its source path.
const consoleIndexFile = "../../web/index.html"

type pwaManifest struct {
	Name            string    `json:"name"`
	ShortName       string    `json:"short_name"`
	StartURL        string    `json:"start_url"`
	Scope           string    `json:"scope"`
	Display         string    `json:"display"`
	BackgroundColor string    `json:"background_color"`
	ThemeColor      string    `json:"theme_color"`
	ID              *string   `json:"id"`
	Icons           []pwaIcon `json:"icons"`
}

type pwaIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose"`
}

func readPWAFile(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(publicConsoleDir, filepath.FromSlash(name)))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func readManifest(t *testing.T) pwaManifest {
	t.Helper()
	var manifest pwaManifest
	if err := json.Unmarshal(readPWAFile(t, manifestFile), &manifest); err != nil {
		t.Fatalf("%s is not valid JSON: %v", manifestFile, err)
	}
	return manifest
}

// The manifest is the install contract, so its members are asserted rather than
// assumed from the file existing.
func TestManifestIsInstallable(t *testing.T) {
	manifest := readManifest(t)

	if manifest.Name == "" || manifest.ShortName == "" {
		t.Fatalf("name and short_name are required: %#v", manifest)
	}
	// start_url and scope are relative on purpose: they resolve against the manifest
	// URL, so this single file is correct at the site root, under /omc and under a
	// nested base path. An absolute path here would make the manifest describe one
	// mount point only.
	if manifest.StartURL != "./" || manifest.Scope != "./" {
		t.Fatalf("start_url = %q scope = %q, want ./ for both so the manifest URL anchors them", manifest.StartURL, manifest.Scope)
	}
	if manifest.Display != "standalone" {
		t.Fatalf("display = %q, want standalone", manifest.Display)
	}
	// A relative id is resolved against start_url's ORIGIN, not the manifest URL, so
	// `"id": "./"` would resolve to the site root for every mount point and make two
	// deployments of the same host present themselves as one installed app. Omitted,
	// the identity is the resolved start_url, which already differs per mount. If this
	// member ever becomes necessary, it has to be an absolute, mount-specific URL,
	// which in turn would require a per-deployment manifest.
	if manifest.ID != nil {
		t.Fatalf("the manifest must not carry id (%q): a relative id resolves against start_url's origin and collides across mount points", *manifest.ID)
	}
	if manifest.ThemeColor == "" || manifest.BackgroundColor == "" {
		t.Fatalf("theme_color and background_color are required for the install surfaces: %#v", manifest)
	}

	sizes := map[string]int{}
	maskable := false
	for _, icon := range manifest.Icons {
		if strings.HasPrefix(icon.Src, "/") || strings.Contains(icon.Src, "://") {
			t.Fatalf("icon %q is not relative; it would not follow the manifest's mount point", icon.Src)
		}
		if icon.Purpose == "maskable" {
			maskable = true
		}
		data := readPWAFile(t, strings.TrimPrefix(icon.Src, "./"))
		switch icon.Type {
		case "image/png":
			decoded, err := png.DecodeConfig(bytes.NewReader(data))
			if err != nil {
				t.Fatalf("icon %q is not a decodable PNG: %v", icon.Src, err)
			}
			for _, declared := range strings.Fields(icon.Sizes) {
				var width, height int
				if _, err := fmt.Sscanf(declared, "%dx%d", &width, &height); err != nil {
					t.Fatalf("icon %q declares an unreadable size %q", icon.Src, declared)
				}
				if decoded.Width != width || decoded.Height != height {
					t.Fatalf("icon %q is %dx%d but declares %s", icon.Src, decoded.Width, decoded.Height, declared)
				}
				sizes[declared]++
			}
		default:
			t.Fatalf("icon %q has unsupported type %q", icon.Src, icon.Type)
		}
	}
	// Chromium's installability criteria require both of these sizes, and a maskable
	// icon is what keeps the mark from being cropped on Android.
	for _, required := range []string{"192x192", "512x512"} {
		if sizes[required] == 0 {
			t.Fatalf("the manifest declares no %s icon (declared sizes: %v)", required, sizes)
		}
	}
	if !maskable {
		t.Fatal("the manifest declares no maskable icon")
	}
}

// The routes have to work at every mount point, including a deep link. The manifest
// is fetched by the browser from beside the app, not from the page's route.
func TestInstallableAppSurfaceServesEveryMountPath(t *testing.T) {
	manifestBytes := readPWAFile(t, manifestFile)
	manifest := readManifest(t)
	for _, basePath := range []string{"", "/", "/omc", "/nested/console"} {
		t.Run("base="+basePath, func(t *testing.T) {
			handler := testHandler(t, basePath)
			handler.consoleRoot = os.DirFS(publicConsoleDir)
			server := httptest.NewServer(handler.Router())
			defer server.Close()

			prefix := strings.TrimSuffix(basePath, "/")
			manifestURL := prefix + "/manifest.webmanifest"

			response, err := http.Get(server.URL + manifestURL)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("GET %s status = %d, want 200", manifestURL, response.StatusCode)
			}
			if contentType := response.Header.Get("Content-Type"); contentType != "application/manifest+json" {
				t.Fatalf("manifest content type = %q, want application/manifest+json", contentType)
			}
			// The name is not content-hashed, so immutable would pin an old manifest in
			// the browser and an installed app would never see a manifest change.
			if cache := response.Header.Get("Cache-Control"); cache != "no-cache" {
				t.Fatalf("manifest cache-control = %q, want no-cache", cache)
			}
			if readErr != nil || !bytes.Equal(body, manifestBytes) {
				t.Fatalf("served manifest is not the committed document (read %d of %d bytes, err %v)", len(body), len(manifestBytes), readErr)
			}

			head, err := http.Head(server.URL + manifestURL)
			if err != nil {
				t.Fatal(err)
			}
			head.Body.Close()
			if head.StatusCode != http.StatusOK {
				t.Fatalf("HEAD %s status = %d, want 200", manifestURL, head.StatusCode)
			}
			if head.Header.Get("Content-Length") != response.Header.Get("Content-Length") {
				t.Fatalf("HEAD content length %q differs from GET %q", head.Header.Get("Content-Length"), response.Header.Get("Content-Length"))
			}

			// Every icon the manifest names must come through this revalidating route. A
			// future icon pointing at an unhashed file served by asset() would otherwise
			// inherit its immutable policy and stay stale in an installed app.
			for _, icon := range manifest.Icons {
				iconURL := prefix + "/" + strings.TrimPrefix(icon.Src, "./")
				iconResponse, err := http.Get(server.URL + iconURL)
				if err != nil {
					t.Fatal(err)
				}
				iconBytes, readErr := io.ReadAll(iconResponse.Body)
				iconResponse.Body.Close()
				if readErr != nil {
					t.Fatal(readErr)
				}
				if iconResponse.StatusCode != http.StatusOK {
					t.Fatalf("GET %s status = %d, want 200", iconURL, iconResponse.StatusCode)
				}
				if contentType := iconResponse.Header.Get("Content-Type"); contentType != icon.Type {
					t.Fatalf("icon %s content type = %q, want %q", iconURL, contentType, icon.Type)
				}
				if cache := iconResponse.Header.Get("Cache-Control"); cache != "no-cache" {
					t.Fatalf("icon %s cache-control = %q, want no-cache", iconURL, cache)
				}
				if icon.Src == "./icons/icon-192.png" {
					decoded, err := png.DecodeConfig(bytes.NewReader(iconBytes))
					if err != nil || decoded.Width != 192 || decoded.Height != 192 {
						t.Fatalf("served icon is not the 192x192 PNG: %dx%d err=%v", decoded.Width, decoded.Height, err)
					}
				}
			}

			// A missing icon must stop at this handler. Falling through to the SPA
			// fallback would answer 200 with index.html, which the browser reports as a
			// broken icon rather than a missing file.
			missing, err := http.Get(server.URL + prefix + "/icons/does-not-exist.png")
			if err != nil {
				t.Fatal(err)
			}
			missing.Body.Close()
			if missing.StatusCode != http.StatusNotFound {
				t.Fatalf("missing icon status = %d, want 404", missing.StatusCode)
			}
			if contentType := missing.Header.Get("Content-Type"); strings.HasPrefix(contentType, "text/html") {
				t.Fatalf("missing icon content type = %q, want non-HTML", contentType)
			}
		})
	}
}

var (
	baseHrefPattern     = regexp.MustCompile(`<base href="([^"]+)">`)
	manifestLinkPattern = regexp.MustCompile(`<link rel="manifest" href="([^"]+)"`)
	appleIconPattern    = regexp.MustCompile(`<link rel="apple-touch-icon" href="([^"]+)"`)
)

// A deep link is served the shell at its own path, so the shell's relative manifest
// link only resolves correctly because the injected base element names the mount.
func TestDeepLinkResolvesTheManifestUnderTheMountPath(t *testing.T) {
	index, err := os.ReadFile(consoleIndexFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, basePath := range []string{"/", "/omc", "/nested/console"} {
		t.Run("base="+basePath, func(t *testing.T) {
			shell, err := injectRuntimeConfig(string(index), config.Config{BasePath: basePath})
			if err != nil {
				t.Fatal(err)
			}
			base := baseHrefPattern.FindStringSubmatch(shell)
			link := manifestLinkPattern.FindStringSubmatch(shell)
			if base == nil || link == nil {
				t.Fatalf("the shell must carry a base element and a manifest link: %s", shell)
			}
			documentBase, err := url.Parse(base[1])
			if err != nil {
				t.Fatal(err)
			}
			reference, err := url.Parse(link[1])
			if err != nil {
				t.Fatal(err)
			}
			if reference.IsAbs() {
				t.Fatalf("the manifest link %q must be relative so the mount point governs it", link[1])
			}
			resolved := documentBase.ResolveReference(reference).Path
			prefix := strings.TrimSuffix(basePath, "/")
			if want := prefix + "/manifest.webmanifest"; resolved != want {
				t.Fatalf("deep link resolves the manifest to %q, want %q", resolved, want)
			}

			apple := appleIconPattern.FindStringSubmatch(shell)
			if apple == nil {
				t.Fatal("the shell must carry an apple-touch-icon for iOS")
			}
			appleReference, err := url.Parse(apple[1])
			if err != nil || appleReference.IsAbs() {
				t.Fatalf("apple-touch-icon %q must be relative", apple[1])
			}
			iconPath := documentBase.ResolveReference(appleReference).Path
			if !strings.HasSuffix(iconPath, "/icons/apple-touch-icon.png") {
				t.Fatalf("apple-touch-icon resolves to %q", iconPath)
			}
			decoded, err := png.DecodeConfig(bytes.NewReader(readPWAFile(t, "icons/apple-touch-icon.png")))
			if err != nil {
				t.Fatal(err)
			}
			// iOS renders its own mask over the touch icon; 180x180 is the current size.
			if decoded.Width != 180 || decoded.Height != 180 {
				t.Fatalf("apple-touch-icon is %dx%d, want 180x180", decoded.Width, decoded.Height)
			}
		})
	}
}

// The demonstration serves the same install surface, and its boundary does not move:
// the manifest is public build output while the refused operations stay refused.
func TestDemoServesTheInstallableAppSurface(t *testing.T) {
	handler := demoHandler(t, "/omc")
	handler.consoleRoot = os.DirFS(publicConsoleDir)
	server := httptest.NewServer(handler.Router())
	defer server.Close()

	response, err := http.Get(server.URL + "/omc/manifest.webmanifest")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("demo manifest status = %d, want 200", response.StatusCode)
	}
	if demo := response.Header.Get(demoHeader); demo != demoValue {
		t.Fatalf("demo header = %q, want %q", demo, demoValue)
	}

	refused, err := http.Post(server.URL+"/omc/api/v1/management/oauth/start", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	refused.Body.Close()
	if refused.StatusCode != http.StatusForbidden {
		t.Fatalf("refused demo operation status = %d, want 403", refused.StatusCode)
	}
	if code := refused.Header.Get(demoBlockedHeader); code != demoBlockedReason {
		t.Fatalf("refused demo operation blocked header = %q", code)
	}
}
