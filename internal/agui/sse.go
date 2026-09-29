package agui

import (
	"encoding/json"
	"io"
)

// WriteEvent frames one event as a server-sent event. Every event is a single `data:` line, since
// JSON encoding never emits a raw newline.
func WriteEvent(writer io.Writer, event Event) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	frame := make([]byte, 0, len(raw)+8)
	frame = append(frame, "data: "...)
	frame = append(frame, raw...)
	frame = append(frame, "\n\n"...)
	_, err = writer.Write(frame)
	return err
}

// KEEPALIVE is an SSE comment: it keeps intermediaries from closing an idle stream while a
// capability runs, and every consumer ignores it.
const KEEPALIVE = ": keepalive\n\n"
