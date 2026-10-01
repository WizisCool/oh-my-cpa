package api

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

const MAX_STATIC_GZIP_BYTES = 8 << 20

type assetGzipCache struct {
	mutex  sync.Mutex
	assets map[string][]byte
	bytes  int
	limit  int
}

var staticGzipCache = assetGzipCache{assets: make(map[string][]byte), limit: MAX_STATIC_GZIP_BYTES}

var jsonGzipWriters = sync.Pool{New: func() any {
	writer, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return writer
}}

func acceptsGzip(header http.Header) bool {
	wildcardQuality := float64(0)
	for _, entry := range strings.Split(strings.Join(header.Values("Accept-Encoding"), ","), ",") {
		parts := strings.Split(strings.TrimSpace(entry), ";")
		encoding := strings.ToLower(strings.TrimSpace(parts[0]))
		if encoding != "gzip" && encoding != "*" {
			continue
		}
		quality := float64(1)
		for _, parameter := range parts[1:] {
			name, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if !ok || !strings.EqualFold(name, "q") {
				quality = 0
				break
			}
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || !(parsed >= 0 && parsed <= 1) {
				quality = 0
				break
			}
			quality = parsed
		}
		// An explicit refusal wins over a wildcard regardless of their order.
		if encoding == "gzip" {
			return quality > 0
		}
		wildcardQuality = quality
	}
	return wildcardQuality > 0
}

func varyAcceptEncoding(header http.Header) {
	for _, line := range header.Values("Vary") {
		for _, field := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(field), "Accept-Encoding") || strings.TrimSpace(field) == "*" {
				return
			}
		}
	}
	header.Add("Vary", "Accept-Encoding")
}

func allowsTransformation(header http.Header) bool {
	for _, line := range header.Values("Cache-Control") {
		for _, directive := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(directive), "no-transform") {
				return false
			}
		}
	}
	return header.Get("Content-Encoding") == "" && header.Get("Content-Disposition") == "" && len(header.Values("Set-Cookie")) == 0
}

func compressAPIResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodHead || request.Header.Get("Range") != "" || strings.EqualFold(request.URL.Query().Get("include_keys"), "true") {
			next.ServeHTTP(writer, request)
			return
		}
		response := &jsonCompressionWriter{ResponseWriter: writer, isGzipAccepted: acceptsGzip(request.Header)}
		defer response.closeCompression()
		next.ServeHTTP(response, request)
	})
}

type jsonCompressionWriter struct {
	http.ResponseWriter
	isGzipAccepted   bool
	hasWrittenHeader bool
	gzipWriter       *gzip.Writer
}

func (writer *jsonCompressionWriter) WriteHeader(status int) {
	if status >= 100 && status < 200 {
		writer.ResponseWriter.WriteHeader(status)
		return
	}
	if writer.hasWrittenHeader {
		return
	}
	writer.hasWrittenHeader = true
	contentType, _, _ := strings.Cut(writer.Header().Get("Content-Type"), ";")
	// SSE and downloads must reach the client directly: buffering them changes their contract.
	if status != http.StatusNoContent && status != http.StatusNotModified && contentType == "application/json" && allowsTransformation(writer.Header()) {
		varyAcceptEncoding(writer.Header())
		if writer.isGzipAccepted {
			writer.gzipWriter = jsonGzipWriters.Get().(*gzip.Writer)
			writer.gzipWriter.Reset(writer.ResponseWriter)
			writer.Header().Set("Content-Encoding", "gzip")
			writer.Header().Del("Content-Length")
		}
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *jsonCompressionWriter) Write(data []byte) (int, error) {
	if !writer.hasWrittenHeader {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.gzipWriter != nil {
		return writer.gzipWriter.Write(data)
	}
	return writer.ResponseWriter.Write(data)
}

func (writer *jsonCompressionWriter) FlushError() error {
	if !writer.hasWrittenHeader {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.gzipWriter != nil {
		if err := writer.gzipWriter.Flush(); err != nil {
			return err
		}
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

func (writer *jsonCompressionWriter) Flush()                      { _ = writer.FlushError() }
func (writer *jsonCompressionWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *jsonCompressionWriter) closeCompression() {
	if writer.gzipWriter == nil {
		return
	}
	_ = writer.gzipWriter.Close()
	// A pooled encoder must not retain the previous response, its request or its headers.
	writer.gzipWriter.Reset(io.Discard)
	jsonGzipWriters.Put(writer.gzipWriter)
}

func (cache *assetGzipCache) compressAsset(name string, data []byte) []byte {
	if len(data) < 1024 {
		return nil
	}
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if compressed, ok := cache.assets[name]; ok {
		return compressed
	}
	var output bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&output, gzip.BestSpeed)
	_, _ = writer.Write(data)
	_ = writer.Close()
	compressed := output.Bytes()
	if len(compressed) >= len(data) {
		return nil
	}
	// Embedded files never change in a running binary. Cache only compressed text, not fonts
	// or the original bytes, and cap retention so a large icon catalog cannot grow it unbounded.
	if cache.bytes+len(compressed) <= cache.limit {
		cache.assets[name] = compressed
		cache.bytes += len(compressed)
	}
	return compressed
}

func isCompressibleAsset(name string) bool {
	return strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".css") || strings.HasSuffix(name, ".svg") || strings.HasSuffix(name, ".json")
}
