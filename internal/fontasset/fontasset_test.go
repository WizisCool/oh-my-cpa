package fontasset

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/image/font/gofont/gobolditalic"
	"golang.org/x/image/font/gofont/goregular"
)

func TestSniffRefusesWhatIsNotAFontContainer(t *testing.T) {
	for _, content := range [][]byte{[]byte("<html><script>x</script></html>"), []byte("OTT"), append([]byte("%PDF-1.7"), make([]byte, 20)...)} {
		if _, err := Sniff(content); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q sniffed as a font: %v", content, err)
		}
	}
	if format, err := Sniff(goregular.TTF); err != nil || format != FormatTrueType {
		t.Fatalf("TrueType: %q %v", format, err)
	}
}

func TestDescribeReadsTheFontsOwnTables(t *testing.T) {
	// The file name claims Light; the tables declare usWeightClass 600 and italic, and
	// the tables win.
	description, err := Describe(gobolditalic.TTF, "Misnamed-Light.ttf")
	if err != nil {
		t.Fatal(err)
	}
	if description.Family != "Go" || description.WeightMin != 600 || description.WeightMax != 600 || !description.Italic {
		t.Fatalf("%+v", description)
	}
}

func TestDescribeReadsCompressedWOFFTables(t *testing.T) {
	description, err := Describe(toWOFF(t, gobolditalic.TTF), "x.woff")
	if err != nil {
		t.Fatal(err)
	}
	if description.Family != "Go" || description.WeightMin != 600 || !description.Italic {
		t.Fatalf("%+v", description)
	}
}

func TestDescribeFallsBackToTheFileNameForWOFF2(t *testing.T) {
	content := append([]byte("wOF2"), make([]byte, 60)...)
	cases := map[string]Description{
		"JetBrains_Mono-SemiBoldItalic.woff2": {Family: "JetBrains Mono", WeightMin: 600, WeightMax: 600, Italic: true},
		"Inter-Regular.woff2":                {Family: "Inter", WeightMin: 400, WeightMax: 400},
		"Recursive[wght].woff2":              {Family: "Recursive", WeightMin: 100, WeightMax: 900},
		"MiSans-ExtraBold.woff2":             {Family: "MiSans", WeightMin: 800, WeightMax: 800},
	}
	for name, want := range cases {
		got, err := Describe(content, name)
		if err != nil || got != want {
			t.Fatalf("%s: %+v %v, want %+v", name, got, err, want)
		}
	}
}

func TestCleanFamilyRefusesTextThatCouldEscapeACSSString(t *testing.T) {
	for _, name := range []string{"", `Evil"}body{`, "a;b", "x\u0000", strings.Repeat("a", MaxFamilyRunes+1)} {
		if _, err := CleanFamily(name); err == nil {
			t.Fatalf("%q accepted", name)
		}
	}
	if name, err := CleanFamily("  Noto   Sans SC "); err != nil || name != "Noto Sans SC" {
		t.Fatalf("%q %v", name, err)
	}
}

func TestParseStylesheetMergesWeightsThatShareAFile(t *testing.T) {
	stylesheet := `
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v1/a.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/inter/v1/a.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/inter/v1/b.woff2) format('woff2');
  unicode-range: U+0400-045F;
}`
	rules, err := ParseStylesheet(stylesheet)
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 2 || rules[0].WeightMin != 400 || rules[0].WeightMax != 700 || rules[0].UnicodeRange != "U+0000-00FF,U+0131" || rules[1].WeightMax != 400 {
		t.Fatalf("%+v", rules)
	}
	if _, err := ParseStylesheet(`@font-face{font-family:'X';font-weight:400;src:url(a.woff2);unicode-range:U+0-FF;}{}</style>`); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseStylesheet(`@font-face{font-family:'X';font-weight:400;src:url(a.woff2);unicode-range:red}`); err == nil {
		t.Fatal("a non-range unicode-range was accepted")
	}
}

func TestGoogleInstallDownloadsEverySliceFromTheServer(t *testing.T) {
	var server *httptest.Server
	var downloads atomic.Int32
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/css2":
			// The API's own syntax uses `;` inside the value, which Go's query parser
			// refuses, so the raw query is what is checked.
			if !strings.HasPrefix(request.URL.RawQuery, "family=Noto+Sans+SC") {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			if request.URL.RawQuery != "family=Noto+Sans+SC:wght@400;700&display=swap" || !strings.Contains(request.UserAgent(), "Chrome") {
				t.Errorf("stylesheet request: %q %q", request.URL.RawQuery, request.UserAgent())
			}
			for slice := 0; slice < 3; slice++ {
				for _, weight := range []int{400, 700} {
					fmt.Fprintf(writer, "@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:%d;src:url(%s/s/%d-%d.woff2) format('woff2');unicode-range:U+%X-%X;}\n", weight, server.URL, slice, weight, slice*0x100, slice*0x100+0xFF)
				}
			}
		default:
			downloads.Add(1)
			_, _ = writer.Write(append([]byte("wOF2"), []byte(request.URL.Path)...))
		}
	}))
	defer server.Close()
	installer, err := NewGoogleInstaller(server.URL, http.DefaultTransport)
	if err != nil {
		t.Fatal(err)
	}
	family, faces, err := installer.Install(context.Background(), "Noto Sans SC")
	if err != nil {
		t.Fatal(err)
	}
	if family != "Noto Sans SC" || len(faces) != 6 || downloads.Load() != 6 {
		t.Fatalf("%s %d faces, %d downloads", family, len(faces), downloads.Load())
	}
	if faces[3].WeightMin != 700 || faces[3].UnicodeRange != "U+100-1FF" || !bytes.HasSuffix(faces[3].Content, []byte("/s/1-700.woff2")) {
		t.Fatalf("faces lost their order or descriptors: %+v", faces[3])
	}
	if _, _, err := installer.Install(context.Background(), "No Such Family"); !errors.Is(err, ErrGoogleFamilyMissing) {
		t.Fatalf("missing family: %v", err)
	}
}

func TestGoogleInstallRefusesFilesOnAnotherHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fmt.Fprint(writer, "@font-face{font-family:'X';font-weight:400;src:url(https://169.254.169.254/latest.woff2) format('woff2');}")
	}))
	defer server.Close()
	installer, err := NewGoogleInstaller(server.URL, http.DefaultTransport)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := installer.Install(context.Background(), "X"); !errors.Is(err, ErrGoogleUnreachable) {
		t.Fatalf("a stylesheet pointed the installer at another host: %v", err)
	}
}

// toWOFF wraps an sfnt in WOFF 1.0 with every table zlib-compressed.
func toWOFF(t *testing.T, sfnt []byte) []byte {
	t.Helper()
	count := int(binary.BigEndian.Uint16(sfnt[4:6]))
	header := make([]byte, 44+count*20)
	copy(header, "wOFF")
	copy(header[4:8], sfnt[0:4])
	binary.BigEndian.PutUint16(header[12:14], uint16(count))
	var body bytes.Buffer
	for index := 0; index < count; index++ {
		record := sfnt[12+index*16:]
		offset := binary.BigEndian.Uint32(record[8:12])
		length := binary.BigEndian.Uint32(record[12:16])
		var compressed bytes.Buffer
		writer := zlib.NewWriter(&compressed)
		_, _ = writer.Write(sfnt[offset : offset+length])
		_ = writer.Close()
		// WOFF stores a table raw when compression would not shrink it.
		if compressed.Len() >= int(length) {
			compressed.Reset()
			compressed.Write(sfnt[offset : offset+length])
		}
		entry := header[44+index*20:]
		copy(entry[0:4], record[0:4])
		binary.BigEndian.PutUint32(entry[4:8], uint32(len(header)+body.Len()))
		binary.BigEndian.PutUint32(entry[8:12], uint32(compressed.Len()))
		binary.BigEndian.PutUint32(entry[12:16], length)
		body.Write(compressed.Bytes())
		for body.Len()%4 != 0 {
			body.WriteByte(0)
		}
	}
	return append(header, body.Bytes()...)
}
