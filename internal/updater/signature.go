package updater

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// releasePublicKey is the base64 ed25519 public key release manifests are signed
// for. Its private half exists only as the release workflow's signing secret
// (docs/releasing.md). While the file is empty no manifest verifies, so no console
// update of OMC can be applied: an unsigned image is refused rather than installed on
// trust.
//
//go:embed release_public_key.txt
var releasePublicKey string

// MANIFEST_SCHEMA is the manifest layout this build reads.
const MANIFEST_SCHEMA = 1

// TOKEN_LABEL domain-separates the control token from every other value derived from
// the master key.
const TOKEN_LABEL = "oh-my-cpa updater control v1"

// ErrSignature is returned for a manifest that is unsigned, altered, or signed by
// another key.
var ErrSignature = errors.New("the release manifest signature is not valid")

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Manifest names the image a release was published as. It is what the signature
// covers: a release whose tag or assets were replaced still cannot point an install at
// an image the maintainers did not build.
type Manifest struct {
	Schema  int    `json:"schema"`
	Version string `json:"version"`
	Image   struct {
		Repository string `json:"repository"`
		Digest     string `json:"digest"`
	} `json:"image"`
}

// VerifyManifest checks the signature over the exact manifest bytes and then decodes
// them. Decoding first would mean parsing input nobody has vouched for.
func VerifyManifest(publicKey string, manifest []byte, signature string) (Manifest, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKey))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return Manifest{}, fmt.Errorf("%w: this build carries no release key", ErrSignature)
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), manifest, decodedSignature) {
		return Manifest{}, ErrSignature
	}
	var parsed Manifest
	if err := json.Unmarshal(manifest, &parsed); err != nil {
		return Manifest{}, fmt.Errorf("read the release manifest: %w", err)
	}
	if parsed.Schema != MANIFEST_SCHEMA {
		return Manifest{}, fmt.Errorf("release manifest schema %d is not supported", parsed.Schema)
	}
	if !digestPattern.MatchString(parsed.Image.Digest) || strings.TrimSpace(parsed.Image.Repository) == "" {
		return Manifest{}, errors.New("the release manifest does not name an image digest")
	}
	return parsed, nil
}

// ControlToken derives the bearer token of the control interface from the console's
// master key.
//
// The console computes it from its own configuration and the updater from the console
// container's environment, which it can read through the daemon. Neither side needs a
// new setting, which is what lets an existing deployment gain updates without an edit
// to its Compose file.
func ControlToken(masterKey string) string {
	trimmed := strings.TrimSpace(masterKey)
	if trimmed == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(trimmed))
	mac.Write([]byte(TOKEN_LABEL))
	return hex.EncodeToString(mac.Sum(nil))
}
