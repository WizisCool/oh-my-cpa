package iconasset

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func TestValidateImageInputs(t *testing.T) {
	var content bytes.Buffer
	if err := png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{base64.StdEncoding.EncodeToString(content.Bytes()), "data:image/png;base64," + base64.StdEncoding.EncodeToString(content.Bytes()), base64.RawStdEncoding.EncodeToString(content.Bytes()), " \n" + base64.StdEncoding.EncodeToString(content.Bytes()) + "\n"} {
		artwork, err := ValidateImage(input)
		if err != nil || artwork.MIME != "image/png" {
			t.Fatalf("%+v %v", artwork, err)
		}
	}
	var jpegContent bytes.Buffer
	if err := jpeg.Encode(&jpegContent, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateImage(base64.StdEncoding.EncodeToString(jpegContent.Bytes())); err != nil {
		t.Fatal(err)
	}
	// A one-pixel lossless WebP exercises the decoder independently from upload metadata.
	webp := "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="
	if artwork, err := ValidateImage(webp); err != nil || artwork.MIME != "image/webp" {
		t.Fatalf("webp: %+v %v", artwork, err)
	}
	for _, input := range []string{"https://example.com/icon.png", "data:text/html;base64," + base64.StdEncoding.EncodeToString(content.Bytes()), "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(content.Bytes()), "%%%%", base64.StdEncoding.EncodeToString(content.Bytes()[:12])} {
		if _, err := ValidateImage(input); err == nil {
			t.Fatalf("accepted invalid image %q", input[:min(len(input), 40)])
		}
	}
	content.Reset()
	_ = png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 1025, 1)))
	if _, err := ValidateImage(base64.StdEncoding.EncodeToString(content.Bytes())); err == nil {
		t.Fatal("accepted oversized dimensions")
	}
	if _, err := ValidateImage(base64.StdEncoding.EncodeToString(make([]byte, MaxBytes+1))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("size: %v", err)
	}
}
func TestValidateSVGAllowlist(t *testing.T) {
	valid := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="ink"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#ink)" d="M0 0L24 24"/><use href="#ink"/></svg>`
	artwork, err := ValidateImage("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(valid)))
	if err != nil || !strings.Contains(string(artwork.Content), "xmlns=") {
		t.Fatalf("%s %v", artwork.Content, err)
	}
	attacks := []string{`<svg width="1" width="2"/>`, `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#one" xlink:href="#two"/></svg>`, `<svg><script>alert(1)</script></svg>`, `<svg onload="alert(1)"/>`, `<svg><foreignObject/></svg>`, `<!DOCTYPE svg [<!ENTITY attack SYSTEM "file:///etc/passwd">]><svg>&attack;</svg>`, `<svg><use href="https://example.com/a.svg"/></svg>`, `<svg><path fill="url(https://example.com/x)"/></svg>`, `<svg style="fill:red"/>`, `<svg><animate/></svg>`, `<html/>`, `<svg/><svg/>`, `<svg xmlns="http://evil.example"/>`, `<svg><image href="data:image/png;base64,aaa"/></svg>`, `<?xml-stylesheet href="https://example.com/x"?><svg/>`, `<svg><path fill="uRl(#ink) url(https://example.com)"/></svg>`}
	for _, attack := range attacks {
		if _, err := ValidateImage(base64.StdEncoding.EncodeToString([]byte(attack))); err == nil {
			t.Fatalf("accepted %s", attack)
		}
	}
}
func TestAnimatedImageRefusal(t *testing.T) {
	content := make([]byte, 24)
	copy(content, []byte("RIFF"))
	binary.LittleEndian.PutUint32(content[4:], 16)
	copy(content[8:], []byte("WEBPANIM"))
	binary.LittleEndian.PutUint32(content[16:], 4)
	if validateWebPStatic(content) == nil {
		t.Fatal("accepted animated WebP")
	}
	content = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 12)...)
	copy(content[12:16], "acTL")
	if validatePNGStatic(content) == nil {
		t.Fatal("accepted animated PNG")
	}
}
