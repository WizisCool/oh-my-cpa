// Package iconasset validates deployment-owned, static image artwork.
package iconasset

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"regexp"
	"strings"
	"unicode"

	_ "golang.org/x/image/webp"
)

const MaxBytes = 512 * 1024
const MaxDimension = 1024

var ErrTooLarge = errors.New("custom_icon_too_large")
var ErrInvalid = errors.New("custom_icon_invalid_image")

type Image struct {
	MIME    string
	Content []byte
}

func ValidateImage(input string) (Image, error) {
	if len(input) > 1024*1024 {
		return Image{}, ErrTooLarge
	}
	input = strings.TrimSpace(input)
	declaredMIME := ""
	if strings.HasPrefix(strings.ToLower(input), "data:") {
		header, payload, hasComma := strings.Cut(input, ",")
		if !hasComma || !strings.HasSuffix(strings.ToLower(header), ";base64") {
			return Image{}, ErrInvalid
		}
		declaredMIME = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.ToLower(header), "data:"), ";base64"))
		input = payload
	}
	encoded := strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		return character
	}, input)
	if len(encoded) > base64.StdEncoding.EncodedLen(MaxBytes) {
		return Image{}, ErrTooLarge
	}
	content, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		content, err = base64.RawStdEncoding.Strict().DecodeString(encoded)
	}
	if err != nil || len(content) == 0 {
		return Image{}, ErrInvalid
	}
	if len(content) > MaxBytes {
		return Image{}, ErrTooLarge
	}
	artwork := Image{Content: content}
	if bytes.HasPrefix(bytes.TrimSpace(content), []byte("<")) {
		artwork.Content, err = validateSVG(content)
		artwork.MIME = "image/svg+xml"
	} else {
		var config image.Config
		var format string
		config, format, err = image.DecodeConfig(bytes.NewReader(content))
		if err != nil || config.Width < 1 || config.Height < 1 || config.Width > MaxDimension || config.Height > MaxDimension {
			return Image{}, ErrInvalid
		}
		switch format {
		case "png":
			artwork.MIME = "image/png"
			err = validatePNGStatic(content)
		case "jpeg":
			artwork.MIME = "image/jpeg"
		case "webp":
			artwork.MIME = "image/webp"
			err = validateWebPStatic(content)
		default:
			return Image{}, ErrInvalid
		}
		if err == nil {
			_, _, err = image.Decode(bytes.NewReader(content))
		}
	}
	if err != nil {
		return Image{}, ErrInvalid
	}
	if declaredMIME != "" && declaredMIME != artwork.MIME {
		return Image{}, ErrInvalid
	}
	if len(artwork.Content) > MaxBytes {
		return Image{}, ErrTooLarge
	}
	return artwork, nil
}

func validatePNGStatic(content []byte) error {
	for offset := 8; offset+12 <= len(content); {
		length := int(binary.BigEndian.Uint32(content[offset:]))
		if length > len(content)-offset-12 {
			return ErrInvalid
		}
		if string(content[offset+4:offset+8]) == "acTL" {
			return ErrInvalid
		}
		offset += length + 12
	}
	return nil
}
func validateWebPStatic(content []byte) error {
	if len(content) < 12 || int(binary.LittleEndian.Uint32(content[4:8]))+8 != len(content) {
		return ErrInvalid
	}
	for offset := 12; offset+8 <= len(content); {
		length := int(binary.LittleEndian.Uint32(content[offset+4:]))
		if length > len(content)-offset-8 {
			return ErrInvalid
		}
		switch string(content[offset : offset+4]) {
		case "ANIM", "ANMF":
			return ErrInvalid
		}
		offset += 8 + length + (length % 2)
	}
	return nil
}

var SVG_ELEMENTS = setWords("svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask use title desc text tspan")
var SVG_ATTRIBUTES = setWords("id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity transform gradientTransform gradientUnits spreadMethod offset stop-color stop-opacity clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits preserveAspectRatio href font-size font-family font-weight text-anchor dominant-baseline dx dy")
var LOCAL_REFERENCE = regexp.MustCompile(`^#[A-Za-z_][A-Za-z0-9_.:-]*$`)
var LOCAL_URL = regexp.MustCompile(`^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$`)

func setWords(words string) map[string]bool {
	result := map[string]bool{}
	for _, word := range strings.Fields(words) {
		result[word] = true
	}
	return result
}

// Rebuild the allowlisted XML rather than trusting MIME or sanitizing with string replacement.
func validateSVG(content []byte) ([]byte, error) {
	decoder := xml.NewDecoder(bytes.NewReader(content))
	var output bytes.Buffer
	encoder := xml.NewEncoder(&output)
	depth, tokens := 0, 0
	hasRoot := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, ErrInvalid
		}
		tokens++
		if tokens > 100000 {
			return nil, ErrInvalid
		}
		switch item := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				if hasRoot || item.Name.Local != "svg" {
					return nil, ErrInvalid
				}
				hasRoot = true
			}
			if !SVG_ELEMENTS[item.Name.Local] || (item.Name.Space != "" && item.Name.Space != "http://www.w3.org/2000/svg") {
				return nil, ErrInvalid
			}
			depth++
			if depth > 128 {
				return nil, ErrInvalid
			}
			clean := xml.StartElement{Name: xml.Name{Local: item.Name.Local}}
			if depth == 1 {
				clean.Attr = append(clean.Attr, xml.Attr{Name: xml.Name{Local: "xmlns"}, Value: "http://www.w3.org/2000/svg"})
			}
			seenAttributes := map[string]bool{}
			for _, attribute := range item.Attr {
				if attribute.Name.Local == "xmlns" || attribute.Name.Space == "xmlns" {
					continue
				}
				if !SVG_ATTRIBUTES[attribute.Name.Local] || (attribute.Name.Space != "" && !(attribute.Name.Space == "http://www.w3.org/1999/xlink" && attribute.Name.Local == "href")) {
					return nil, ErrInvalid
				}
				if seenAttributes[attribute.Name.Local] {
					return nil, ErrInvalid
				}
				seenAttributes[attribute.Name.Local] = true
				value := strings.TrimSpace(attribute.Value)
				if attribute.Name.Local == "href" && !LOCAL_REFERENCE.MatchString(value) {
					return nil, ErrInvalid
				}
				if strings.Contains(strings.ToLower(value), "url") && !LOCAL_URL.MatchString(value) {
					return nil, ErrInvalid
				}
				if strings.ContainsAny(value, "\\") {
					return nil, ErrInvalid
				}
				clean.Attr = append(clean.Attr, xml.Attr{Name: xml.Name{Local: attribute.Name.Local}, Value: value})
			}
			if err := encoder.EncodeToken(clean); err != nil {
				return nil, err
			}
		case xml.EndElement:
			depth--
			if err := encoder.EncodeToken(xml.EndElement{Name: xml.Name{Local: item.Name.Local}}); err != nil {
				return nil, err
			}
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(item)) != "" {
				return nil, ErrInvalid
			}
			if err := encoder.EncodeToken(item); err != nil {
				return nil, err
			}
		case xml.ProcInst:
			if item.Target != "xml" || hasRoot {
				return nil, ErrInvalid
			}
		case xml.Directive:
			return nil, ErrInvalid
		}
	}
	if !hasRoot || depth != 0 {
		return nil, ErrInvalid
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
