package management

import (
	"net/http"
	"net/http/httptest"
)

// newV8Server is httptest.NewServer for a stand-in v8 gateway: it answers the gate's
// probe itself, so each test's handler sees only the requests it is about.
func newV8Server(handler http.Handler) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management"+MANAGEMENT_V8_PROBE_ENDPOINT {
			_, _ = writer.Write([]byte("8"))
			return
		}
		handler.ServeHTTP(writer, request)
	}))
}
