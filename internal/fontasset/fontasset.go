// Package fontasset validates and describes the font files a deployment stores for its
// console: files an operator uploads and the slices installed from Google Fonts.
//
// A stored font is served back to the browser from the console's own origin, so the
// one thing this package must guarantee is that the bytes are a font container the
// browser will treat as one, never something it could be talked into rendering as a
// document. Description is best effort on top of that: the weight, style and family
// are read from the font's own tables where the container exposes them without a
// decompressor the binary does not carry (WOFF2's tables are Brotli-compressed), and
// guessed from the file name otherwise.
package fontasset

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// MaxFileBytes bounds one font file. A complete CJK family in TrueType runs to about
// 20 MiB per weight, which is the largest file an operator has a reason to upload.
const MaxFileBytes = 32 * 1024 * 1024

// MaxFamilyRunes bounds a family name; it is CSS identifier text, not prose.
const MaxFamilyRunes = 64

var (
	ErrInvalid  = errors.New("font_invalid_file")
	ErrTooLarge = errors.New("font_too_large")
	ErrFamily   = errors.New("font_invalid_family")
)

// Format is the CSS `format()` keyword of a container, which is also its stored name.
type Format string

const (
	FormatWOFF2    Format = "woff2"
	FormatWOFF     Format = "woff"
	FormatTrueType Format = "truetype"
	FormatOpenType Format = "opentype"
)

// MIME is the media type a face is served with.
func (f Format) MIME() string {
	switch f {
	case FormatWOFF2:
		return "font/woff2"
	case FormatWOFF:
		return "font/woff"
	case FormatOpenType:
		return "font/otf"
	default:
		return "font/ttf"
	}
}

// Sniff names the container by its signature and refuses anything else. The extension
// and the declared media type are ignored: both are the uploader's claim, the
// signature is the file's.
func Sniff(content []byte) (Format, error) {
	if len(content) < 12 {
		return "", ErrInvalid
	}
	if len(content) > MaxFileBytes {
		return "", ErrTooLarge
	}
	switch string(content[:4]) {
	case "wOF2":
		return FormatWOFF2, nil
	case "wOFF":
		return FormatWOFF, nil
	case "OTTO":
		return FormatOpenType, nil
	case "\x00\x01\x00\x00", "true":
		return FormatTrueType, nil
	}
	return "", ErrInvalid
}

// Description is what a face says about itself.
type Description struct {
	Family    string
	WeightMin int
	WeightMax int
	Italic    bool
}

// Describe reads a face's family, weight (or weight axis) and style. A file whose
// tables cannot be read - every WOFF2, and anything malformed past its signature - is
// described from its file name instead, which is how font files are conventionally
// named (`Inter-SemiBoldItalic.woff2`, `Recursive[wght].ttf`). A guessed family is
// only the library's label - the console declares every face under its own name - so
// a file name that spells it imperfectly costs nothing but a rename at upload.
func Describe(content []byte, fileName string) (Description, error) {
	format, err := Sniff(content)
	if err != nil {
		return Description{}, err
	}
	guessed := describeFileName(fileName)
	var tables map[string][]byte
	switch format {
	case FormatTrueType, FormatOpenType:
		tables, err = sfntTables(content)
	case FormatWOFF:
		tables, err = woffTables(content)
	default:
		return guessed, nil
	}
	if err != nil {
		// A container whose directory does not parse is not a font the browser will
		// load either; refusing it here is a clearer answer than a silent fallback face.
		return Description{}, ErrInvalid
	}
	description := guessed
	if family := familyName(tables["name"]); family != "" {
		description.Family = family
	}
	if os2 := tables["OS/2"]; len(os2) >= 64 {
		if weight := int(binary.BigEndian.Uint16(os2[4:6])); weight >= 1 && weight <= 1000 {
			description.WeightMin, description.WeightMax = weight, weight
		}
		description.Italic = binary.BigEndian.Uint16(os2[62:64])&1 == 1
	}
	if low, high, ok := weightAxis(tables["fvar"]); ok {
		description.WeightMin, description.WeightMax = low, high
	}
	return description, nil
}

var tableWanted = map[string]bool{"name": true, "OS/2": true, "fvar": true}

// maxTableBytes bounds what one described table may inflate to; the three tables read
// here are a few kilobytes in any real font.
const maxTableBytes = 1 << 20

func sfntTables(content []byte) (map[string][]byte, error) {
	if len(content) < 12 {
		return nil, ErrInvalid
	}
	count := int(binary.BigEndian.Uint16(content[4:6]))
	if 12+count*16 > len(content) {
		return nil, ErrInvalid
	}
	tables := map[string][]byte{}
	for index := 0; index < count; index++ {
		record := content[12+index*16:]
		tag := string(record[:4])
		offset := int(binary.BigEndian.Uint32(record[8:12]))
		length := int(binary.BigEndian.Uint32(record[12:16]))
		if offset < 0 || length < 0 || offset+length > len(content) || offset+length < offset {
			return nil, ErrInvalid
		}
		if tableWanted[tag] {
			tables[tag] = content[offset : offset+length]
		}
	}
	return tables, nil
}

func woffTables(content []byte) (map[string][]byte, error) {
	if len(content) < 44 {
		return nil, ErrInvalid
	}
	count := int(binary.BigEndian.Uint16(content[12:14]))
	if 44+count*20 > len(content) {
		return nil, ErrInvalid
	}
	tables := map[string][]byte{}
	for index := 0; index < count; index++ {
		record := content[44+index*20:]
		tag := string(record[:4])
		offset := int(binary.BigEndian.Uint32(record[4:8]))
		compressed := int(binary.BigEndian.Uint32(record[8:12]))
		original := int(binary.BigEndian.Uint32(record[12:16]))
		if offset < 0 || compressed < 0 || offset+compressed > len(content) || offset+compressed < offset {
			return nil, ErrInvalid
		}
		if !tableWanted[tag] {
			continue
		}
		data := content[offset : offset+compressed]
		if compressed < original {
			if original > maxTableBytes {
				return nil, ErrInvalid
			}
			reader, err := zlib.NewReader(bytes.NewReader(data))
			if err != nil {
				return nil, ErrInvalid
			}
			inflated, err := io.ReadAll(io.LimitReader(reader, int64(original)+1))
			_ = reader.Close()
			if err != nil || len(inflated) != original {
				return nil, ErrInvalid
			}
			data = inflated
		}
		tables[tag] = data
	}
	return tables, nil
}

// familyName prefers the typographic family (name ID 16) over the legacy one (ID 1),
// because the legacy family of a Bold file of a four-style family is still the family,
// while the legacy family of a Medium file is "Inter Medium".
func familyName(table []byte) string {
	if len(table) < 6 {
		return ""
	}
	count := int(binary.BigEndian.Uint16(table[2:4]))
	storage := int(binary.BigEndian.Uint16(table[4:6]))
	best, bestScore := "", -1
	for index := 0; index < count; index++ {
		start := 6 + index*12
		if start+12 > len(table) {
			break
		}
		record := table[start : start+12]
		platform := binary.BigEndian.Uint16(record[0:2])
		language := binary.BigEndian.Uint16(record[4:6])
		nameID := binary.BigEndian.Uint16(record[6:8])
		length := int(binary.BigEndian.Uint16(record[8:10]))
		offset := storage + int(binary.BigEndian.Uint16(record[10:12]))
		if (nameID != 1 && nameID != 16) || offset+length > len(table) {
			continue
		}
		raw := table[offset : offset+length]
		var text string
		switch platform {
		case 0, 3:
			if len(raw)%2 != 0 {
				continue
			}
			units := make([]uint16, len(raw)/2)
			for unit := range units {
				units[unit] = binary.BigEndian.Uint16(raw[unit*2:])
			}
			text = string(utf16.Decode(units))
		case 1:
			text = string(raw)
		default:
			continue
		}
		score := 0
		if nameID == 16 {
			score += 4
		}
		if platform == 3 && language == 0x409 {
			score += 2
		} else if platform == 3 || platform == 0 {
			score++
		}
		if clean, err := CleanFamily(text); err == nil && score > bestScore {
			best, bestScore = clean, score
		}
	}
	return best
}

func weightAxis(table []byte) (int, int, bool) {
	if len(table) < 16 {
		return 0, 0, false
	}
	axesOffset := int(binary.BigEndian.Uint16(table[4:6]))
	axisCount := int(binary.BigEndian.Uint16(table[8:10]))
	axisSize := int(binary.BigEndian.Uint16(table[10:12]))
	if axisSize < 20 {
		return 0, 0, false
	}
	for index := 0; index < axisCount; index++ {
		start := axesOffset + index*axisSize
		if start+20 > len(table) {
			break
		}
		axis := table[start:]
		if string(axis[:4]) != "wght" {
			continue
		}
		low := fixedToInt(binary.BigEndian.Uint32(axis[4:8]))
		high := fixedToInt(binary.BigEndian.Uint32(axis[12:16]))
		if low >= 1 && high <= 1000 && low <= high {
			return low, high, true
		}
	}
	return 0, 0, false
}

func fixedToInt(value uint32) int {
	return int(math.Round(float64(int32(value)) / 65536))
}

var weightWords = []struct {
	word   string
	weight int
}{
	// Longer words first, so "extrabold" is not read as "bold".
	{"extralight", 200}, {"ultralight", 200}, {"extrabold", 800}, {"ultrabold", 800},
	{"semibold", 600}, {"demibold", 600}, {"hairline", 100}, {"thin", 100},
	{"light", 300}, {"regular", 400}, {"normal", 400}, {"book", 400},
	{"medium", 500}, {"bold", 700}, {"black", 900}, {"heavy", 900},
}

var variableMarker = regexp.MustCompile(`(?i)(\[[^\]]*wght[^\]]*\]|[-_ ]?variable|[-_ ]vf$)`)

func describeFileName(fileName string) Description {
	stem := strings.TrimSuffix(path.Base(strings.ReplaceAll(fileName, "\\", "/")), path.Ext(fileName))
	description := Description{WeightMin: 400, WeightMax: 400}
	lower := strings.ToLower(stem)
	family := stem
	if variableMarker.MatchString(stem) {
		description.WeightMin, description.WeightMax = 100, 900
		family = variableMarker.ReplaceAllString(family, "")
	}
	if strings.Contains(lower, "italic") || strings.Contains(lower, "oblique") {
		description.Italic = true
	}
	// The style part conventionally follows the last hyphen: `Inter-SemiBoldItalic`.
	if head, tail, ok := cutLast(family, "-"); ok {
		styleWords := strings.ToLower(tail)
		for _, entry := range weightWords {
			if strings.Contains(styleWords, entry.word) {
				if description.WeightMin == description.WeightMax {
					description.WeightMin, description.WeightMax = entry.weight, entry.weight
				}
				break
			}
		}
		if styleWords != "" && (description.WeightMin != 400 || description.Italic || strings.Contains(styleWords, "regular")) {
			family = head
		}
	}
	description.Family, _ = CleanFamily(strings.NewReplacer("_", " ", "-", " ").Replace(family))
	return description
}

func cutLast(text, separator string) (string, string, bool) {
	index := strings.LastIndex(text, separator)
	if index < 0 {
		return text, "", false
	}
	return text[:index], text[index+len(separator):], true
}

// CleanFamily normalises a family name and refuses one the console could not safely
// quote into a CSS `font-family` value.
func CleanFamily(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > MaxFamilyRunes {
		return "", ErrFamily
	}
	for _, character := range name {
		if unicode.IsControl(character) || strings.ContainsRune(`"'\;{}<>()`, character) {
			return "", ErrFamily
		}
	}
	return name, nil
}
