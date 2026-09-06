// Package logbuf keeps the most recent log records in memory so they can be
// read back over HTTP.
//
// The server runs in a distroless container with no shell, reached only through
// a tunnel, so "docker logs" is available to whoever is sitting at the host and
// to nobody else. Without this, the single most useful thing when diagnosing a
// problem remotely is the one thing that cannot be fetched.
package logbuf

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"strings"
	"sync"
	"time"
)

// Record is one retained log line, flattened into something that survives a
// round trip through JSON.
type Record struct {
	Time  time.Time      `json:"time"`
	Level slog.Level     `json:"level"`
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// Buffer retains the last N records. The zero value is not usable; call New.
type Buffer struct {
	mu      sync.Mutex
	records []Record
	next    int
	wrapped bool
}

// New returns a buffer holding at most size records.
func New(size int) *Buffer {
	if size < 1 {
		size = 1
	}
	return &Buffer{records: make([]Record, size)}
}

// Handler wraps inner so that everything it logs is also retained here.
//
// Wrap the real handler rather than replacing it: the container's stdout stays
// the record of last resort, and a process that dies takes this buffer with it.
func (b *Buffer) Handler(inner slog.Handler) slog.Handler {
	return &handler{inner: inner, buf: b}
}

func (b *Buffer) append(r Record) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.records[b.next] = r
	b.next++
	if b.next == len(b.records) {
		b.next = 0
		b.wrapped = true
	}
}

// Cap reports how many records the buffer can hold.
func (b *Buffer) Cap() int { return len(b.records) }

// Len reports how many it currently holds.
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.wrapped {
		return len(b.records)
	}
	return b.next
}

// Tail returns up to limit of the most recent records at or above minLevel,
// oldest first. When contains is non-empty only records whose message or
// attributes mention it are returned, matched case-insensitively.
func (b *Buffer) Tail(limit int, minLevel slog.Level, contains string) []Record {
	if limit < 1 {
		return nil
	}
	needle := strings.ToLower(contains)

	b.mu.Lock()
	defer b.mu.Unlock()

	// Walk backwards from the newest so the limit keeps the recent end, then
	// reverse: a tail is only useful if it is the tail.
	var out []Record
	count := b.next
	if b.wrapped {
		count = len(b.records)
	}
	for i := range count {
		index := (b.next - 1 - i + len(b.records)*2) % len(b.records)
		record := b.records[index]
		if record.Level < minLevel {
			continue
		}
		if needle != "" && !mentions(record, needle) {
			continue
		}
		out = append(out, record)
		if len(out) == limit {
			break
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func mentions(r Record, needle string) bool {
	if strings.Contains(strings.ToLower(r.Msg), needle) {
		return true
	}
	for key, value := range r.Attrs {
		if strings.Contains(strings.ToLower(key), needle) {
			return true
		}
		if strings.Contains(strings.ToLower(fmt.Sprint(value)), needle) {
			return true
		}
	}
	return false
}

// handler forwards to inner and retains a copy.
type handler struct {
	inner  slog.Handler
	buf    *Buffer
	fields map[string]any // attrs accumulated by WithAttrs, already flattened
	prefix string         // group path, "" or "outer.inner."
}

func (h *handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	fields := make(map[string]any, len(h.fields)+r.NumAttrs())
	maps.Copy(fields, h.fields)
	r.Attrs(func(a slog.Attr) bool {
		flatten(fields, h.prefix, a)
		return true
	})
	if len(fields) == 0 {
		fields = nil
	}
	h.buf.append(Record{Time: r.Time, Level: r.Level, Msg: r.Message, Attrs: fields})
	return h.inner.Handle(ctx, r)
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	next := h.clone()
	for _, a := range attrs {
		flatten(next.fields, h.prefix, a)
	}
	next.inner = h.inner.WithAttrs(attrs)
	return next
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	next := h.clone()
	next.prefix = h.prefix + name + "."
	next.inner = h.inner.WithGroup(name)
	return next
}

func (h *handler) clone() *handler {
	fields := make(map[string]any, len(h.fields))
	maps.Copy(fields, h.fields)
	return &handler{inner: h.inner, buf: h.buf, fields: fields, prefix: h.prefix}
}

// flatten writes one attribute into dst, turning groups into dotted keys.
func flatten(dst map[string]any, prefix string, a slog.Attr) {
	value := a.Value.Resolve()
	if value.Kind() == slog.KindGroup {
		group := prefix
		// An empty key inlines the group, which is what slog itself does.
		if a.Key != "" {
			group += a.Key + "."
		}
		for _, child := range value.Group() {
			flatten(dst, group, child)
		}
		return
	}
	if a.Key == "" {
		return
	}
	dst[prefix+a.Key] = readable(value.Any())
}

// readable converts values JSON would otherwise render uselessly.
//
// An error is the common case: json.Marshal of most error types yields "{}",
// which loses precisely the thing being logged.
func readable(v any) any {
	switch typed := v.(type) {
	case nil, bool, string, float32, float64,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64:
		return v
	case error:
		return typed.Error()
	case time.Duration:
		return typed.String()
	case time.Time:
		return typed
	case fmt.Stringer:
		return typed.String()
	default:
		return fmt.Sprint(v)
	}
}
