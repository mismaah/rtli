package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pair returns a writer and a read-only reader over the same file.
func pair(t *testing.T) (*DB, *DB) {
	t.Helper()
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "rtld.db")

	writer, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { writer.Close() })

	reader, err := OpenReadOnly(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close() })

	return writer, reader
}

func seed(t *testing.T, writer *DB) {
	t.Helper()
	at := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC).UnixMilli()
	fixes := []Fix{
		{RouteCode: "133", BusCode: "A1", AtMs: at, Lat: 4.17, Lng: 73.51},
		{RouteCode: "133", BusCode: "A1", AtMs: at + 10_000, Lat: 4.18, Lng: 73.52},
		{RouteCode: "144", BusCode: "B2", AtMs: at + 20_000, Lat: 4.19, Lng: 73.53},
	}
	if err := writer.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatal(err)
	}
}

func TestReadOnlySeesTheWritersData(t *testing.T) {
	writer, reader := pair(t)
	seed(t, writer)

	result, err := reader.Query(t.Context(),
		`SELECT route_code, COUNT(*) FROM bus_fix GROUP BY route_code ORDER BY route_code`, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowCount != 2 {
		t.Fatalf("want 2 rows, got %d (%+v)", result.RowCount, result.Rows)
	}
	if result.Columns[0] != "route_code" {
		t.Errorf("unexpected columns: %v", result.Columns)
	}
	if result.Rows[0][0] != "133" || result.Rows[0][1] != int64(2) {
		t.Errorf("unexpected first row: %+v", result.Rows[0])
	}
}

// The whole safety argument rests on SQLite refusing the write, not on anyone
// reading the statement first.
func TestReadOnlyRefusesWrites(t *testing.T) {
	writer, reader := pair(t)
	seed(t, writer)

	for _, statement := range []string{
		`DELETE FROM bus_fix`,
		`INSERT INTO bus_fix (route_code, bus_code, at_ms, lat, lng) VALUES ('9', 'X', 1, 0, 0)`,
		`UPDATE bus_fix SET lat = 0`,
		`DROP TABLE bus_fix`,
		`CREATE TABLE sneaky (id INTEGER)`,
		`PRAGMA journal_mode = DELETE`,
		`VACUUM`,
	} {
		if _, err := reader.Query(t.Context(), statement, nil, 0); err == nil {
			t.Errorf("read-only handle accepted %q", statement)
		}
	}

	// And the data is still there.
	result, err := reader.Query(t.Context(), `SELECT COUNT(*) FROM bus_fix`, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != int64(3) {
		t.Errorf("want 3 fixes still present, got %v", result.Rows[0][0])
	}
}

func TestQueryArgsAndLimit(t *testing.T) {
	writer, reader := pair(t)
	seed(t, writer)

	t.Run("args are bound", func(t *testing.T) {
		result, err := reader.Query(t.Context(),
			`SELECT bus_code FROM bus_fix WHERE route_code = ?`, []any{"144"}, 0)
		if err != nil {
			t.Fatal(err)
		}
		if result.RowCount != 1 || result.Rows[0][0] != "B2" {
			t.Errorf("unexpected rows: %+v", result.Rows)
		}
	})

	t.Run("limit truncates and says so", func(t *testing.T) {
		result, err := reader.Query(t.Context(), `SELECT * FROM bus_fix`, nil, 2)
		if err != nil {
			t.Fatal(err)
		}
		if result.RowCount != 2 || !result.Truncated {
			t.Errorf("want 2 rows and truncated, got %d truncated=%v", result.RowCount, result.Truncated)
		}
	})

	t.Run("an exhausted result is not truncated", func(t *testing.T) {
		result, err := reader.Query(t.Context(), `SELECT * FROM bus_fix`, nil, 3)
		if err != nil {
			t.Fatal(err)
		}
		if result.Truncated {
			t.Error("a complete result was reported as truncated")
		}
	})

	t.Run("limit is capped", func(t *testing.T) {
		if _, err := reader.Query(t.Context(), `SELECT 1`, nil, 1_000_000); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("empty query", func(t *testing.T) {
		if _, err := reader.Query(t.Context(), "   ", nil, 0); err == nil {
			t.Error("an empty query was accepted")
		}
	})
}

func TestQueryRendersBlobs(t *testing.T) {
	writer, reader := pair(t)
	// PutTimetable gzips its payload, so this lands as a real BLOB.
	if err := writer.PutTimetable(t.Context(), "2026-09-01", []byte(strings.Repeat("x", 64<<10))); err != nil {
		t.Fatal(err)
	}

	result, err := reader.Query(t.Context(), `SELECT payload FROM day_timetable`, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	blob, ok := result.Rows[0][0].(Blob)
	if !ok {
		t.Fatalf("want a Blob, got %T", result.Rows[0][0])
	}
	if blob.Bytes == 0 {
		t.Error("blob reported as empty")
	}
	if len(blob.Base64) > maxBlobBytes*2 {
		t.Errorf("blob was not clipped: %d encoded bytes", len(blob.Base64))
	}
}

func TestSchemaInfo(t *testing.T) {
	writer, reader := pair(t)
	seed(t, writer)

	schema, err := reader.SchemaInfo(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}

	var busFix *SchemaObject
	for i, object := range schema.Objects {
		if object.Name == "bus_fix" && object.Type == "table" {
			busFix = &schema.Objects[i]
		}
	}
	if busFix == nil {
		t.Fatal("bus_fix missing from the schema")
	}
	if busFix.Rows == nil || *busFix.Rows != 3 {
		t.Errorf("want 3 rows counted, got %v", busFix.Rows)
	}
	if !strings.Contains(busFix.SQL, "CREATE TABLE") {
		t.Errorf("no DDL for bus_fix: %q", busFix.SQL)
	}

	if schema.Pragmas["journal_mode"] != "wal" {
		t.Errorf("want WAL, got %v", schema.Pragmas["journal_mode"])
	}
	if schema.SizeBytes <= 0 {
		t.Errorf("want a non-zero file size, got %d", schema.SizeBytes)
	}
	if len(schema.Integrity) != 1 || schema.Integrity[0] != "ok" {
		t.Errorf("integrity check: %v", schema.Integrity)
	}

	// Skipped by default because it reads every page.
	shallow, err := reader.SchemaInfo(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(shallow.Integrity) != 0 {
		t.Errorf("integrity check ran when it was not asked for: %v", shallow.Integrity)
	}
}

func TestOpenReadOnlyRejectsMemory(t *testing.T) {
	if _, err := OpenReadOnly(context.Background(), ":memory:"); err == nil {
		t.Error("an in-memory read-only handle was allowed")
	}
	if _, err := OpenReadOnly(context.Background(), ""); err == nil {
		t.Error("an empty path was allowed")
	}
}
