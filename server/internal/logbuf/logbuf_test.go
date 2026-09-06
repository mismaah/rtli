package logbuf

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func newLogger(buf *Buffer, sink io.Writer) *slog.Logger {
	inner := slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(buf.Handler(inner))
}

func TestRetainsAndForwards(t *testing.T) {
	var sink bytes.Buffer
	buf := New(10)
	log := newLogger(buf, &sink)

	log.Info("listening", "addr", ":8080")

	records := buf.Tail(10, slog.LevelDebug, "")
	if len(records) != 1 {
		t.Fatalf("want 1 record, got %d", len(records))
	}
	if records[0].Msg != "listening" || records[0].Attrs["addr"] != ":8080" {
		t.Errorf("unexpected record: %+v", records[0])
	}
	// The container's stdout stays the record of last resort.
	if !strings.Contains(sink.String(), `"msg":"listening"`) {
		t.Errorf("record was not forwarded to the inner handler: %s", sink.String())
	}
}

func TestRingDropsOldest(t *testing.T) {
	buf := New(3)
	log := newLogger(buf, io.Discard)
	for _, msg := range []string{"one", "two", "three", "four", "five"} {
		log.Info(msg)
	}

	if buf.Len() != 3 || buf.Cap() != 3 {
		t.Fatalf("want 3/3, got %d/%d", buf.Len(), buf.Cap())
	}
	got := messages(buf.Tail(10, slog.LevelDebug, ""))
	want := []string{"three", "four", "five"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("want %v, got %v", want, got)
	}
}

// A tail that drops the newest entries when it hits the limit is worse than
// useless, so pin the direction down.
func TestTailKeepsTheRecentEnd(t *testing.T) {
	buf := New(10)
	log := newLogger(buf, io.Discard)
	for _, msg := range []string{"one", "two", "three", "four"} {
		log.Info(msg)
	}
	got := messages(buf.Tail(2, slog.LevelDebug, ""))
	if strings.Join(got, ",") != "three,four" {
		t.Errorf("want [three four], got %v", got)
	}
}

func TestTailFilters(t *testing.T) {
	buf := New(20)
	log := newLogger(buf, io.Discard)
	log.Debug("noise")
	log.Info("retention pass complete", "fixes", 12)
	log.Warn("prune failed", "err", errors.New("disk full"))
	log.Error("could not reach upstream")

	t.Run("by level", func(t *testing.T) {
		got := messages(buf.Tail(10, slog.LevelWarn, ""))
		if strings.Join(got, ",") != "prune failed,could not reach upstream" {
			t.Errorf("got %v", got)
		}
	})

	t.Run("by message substring", func(t *testing.T) {
		got := messages(buf.Tail(10, slog.LevelDebug, "RETENTION"))
		if strings.Join(got, ",") != "retention pass complete" {
			t.Errorf("got %v", got)
		}
	})

	t.Run("by attribute value", func(t *testing.T) {
		got := messages(buf.Tail(10, slog.LevelDebug, "disk full"))
		if strings.Join(got, ",") != "prune failed" {
			t.Errorf("got %v", got)
		}
	})
}

// slog's own JSON handler renders most errors as "{}", which loses the only
// part worth reading.
func TestErrorsAreRenderedReadably(t *testing.T) {
	buf := New(4)
	log := newLogger(buf, io.Discard)
	log.Error("prune failed", "err", errors.New("database is locked"), "took", 3*time.Second)

	attrs := buf.Tail(1, slog.LevelDebug, "")[0].Attrs
	if attrs["err"] != "database is locked" {
		t.Errorf(`want "database is locked", got %#v`, attrs["err"])
	}
	if attrs["took"] != "3s" {
		t.Errorf(`want "3s", got %#v`, attrs["took"])
	}
}

func TestWithAttrsAndGroups(t *testing.T) {
	buf := New(4)
	log := newLogger(buf, io.Discard).With("component", "poller").WithGroup("route")
	log.Info("polled", "code", "133", "buses", 4)

	record := buf.Tail(1, slog.LevelDebug, "")[0]
	if record.Attrs["component"] != "poller" {
		t.Errorf("lost the With attr: %+v", record.Attrs)
	}
	if record.Attrs["route.code"] != "133" {
		t.Errorf("group prefix missing: %+v", record.Attrs)
	}
}

// The buffer is shared between the poller, the rollup and every request.
func TestConcurrentWrites(t *testing.T) {
	buf := New(64)
	log := newLogger(buf, io.Discard)
	done := make(chan struct{})
	for i := range 8 {
		go func() {
			defer func() { done <- struct{}{} }()
			for range 50 {
				log.Info("tick", "worker", i)
				buf.Tail(5, slog.LevelDebug, "")
			}
		}()
	}
	for range 8 {
		<-done
	}
	if buf.Len() != 64 {
		t.Errorf("want a full buffer, got %d", buf.Len())
	}
}

func TestRecordMarshalsLevelAsAName(t *testing.T) {
	buf := New(2)
	newLogger(buf, io.Discard).Warn("careful")

	encoded, err := json.Marshal(buf.Tail(1, slog.LevelDebug, "")[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"level":"WARN"`) {
		t.Errorf("want a named level, got %s", encoded)
	}
}

func messages(records []Record) []string {
	out := make([]string, len(records))
	for i, r := range records {
		out[i] = r.Msg
	}
	return out
}
