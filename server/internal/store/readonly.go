package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// Query limits. A diagnostic query is answered into an HTTP response held
// entirely in memory, so both the row count and the total size are bounded.
const (
	DefaultQueryLimit = 200
	MaxQueryLimit     = 5000
	// maxBlobBytes truncates BLOB columns. day_timetable.payload is a gzipped
	// day of departures and would otherwise be the whole response.
	maxBlobBytes = 4 << 10
	// maxResultBytes is a rough ceiling on the rendered rows.
	maxResultBytes = 8 << 20
)

// OpenReadOnly opens a second handle to an existing database that cannot write
// to it.
//
// Separate from Open for two reasons. It must not migrate: running schema.sql
// against a database opened for diagnosis would be a write, and a surprising
// one. And the writer's handle is capped at a single connection which the
// poller and the rollup already contend for — sending ad-hoc queries through it
// would make a slow query stall recording.
//
// Read-only is enforced by SQLite rather than by inspecting the statement, so
// there is no clever SQL that gets around it.
func OpenReadOnly(ctx context.Context, path string) (*DB, error) {
	if path == "" {
		return nil, fmt.Errorf("open read-only: no path")
	}
	if path == ":memory:" {
		// Each connection to :memory: is its own empty database, so a
		// read-only handle to one could never see the writer's data.
		return nil, fmt.Errorf("open read-only: %q has no separate reader", path)
	}

	// mode=ro is the stronger guarantee, but the database is in WAL and a
	// read-only connection cannot create the -shm file it needs. In practice
	// the writer opened first and it already exists; if it does not, fall back
	// to query_only, which SQLite enforces just as firmly for this connection
	// and only gives up the inability to recover a WAL.
	attempts := []string{
		"file:" + path + "?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(true)",
		"file:" + path + "?_pragma=busy_timeout(5000)&_pragma=query_only(true)",
	}
	var err error
	for _, dsn := range attempts {
		var handle *sql.DB
		handle, err = sql.Open("sqlite", dsn)
		if err != nil {
			continue
		}
		// A few readers are fine: unlike writes, they do not serialise.
		handle.SetMaxOpenConns(4)
		if err = handle.PingContext(ctx); err != nil {
			handle.Close()
			continue
		}
		return &DB{sql: handle}, nil
	}
	return nil, fmt.Errorf("open read-only %s: %w", path, err)
}

// QueryResult is the outcome of an ad-hoc query.
type QueryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	RowCount  int      `json:"rowCount"`
	Truncated bool     `json:"truncated,omitempty"`
	TookMs    int64    `json:"tookMs"`
}

// Blob stands in for a BLOB column, which has no JSON representation and is
// usually not what the reader wanted to see in full anyway.
type Blob struct {
	Bytes     int    `json:"bytes"`
	Base64    string `json:"base64"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Query runs an arbitrary statement and returns its rows.
//
// Safe only because the handle it runs on cannot write; do not call it on a
// database opened with Open.
func (db *DB) Query(ctx context.Context, query string, args []any, limit int) (*QueryResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query: empty")
	}
	switch {
	case limit <= 0:
		limit = DefaultQueryLimit
	case limit > MaxQueryLimit:
		limit = MaxQueryLimit
	}

	started := time.Now()
	rows, err := db.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	result := &QueryResult{Columns: columns, Rows: [][]any{}}
	scanned := make([]any, len(columns))
	into := make([]any, len(columns))
	for i := range scanned {
		into[i] = &scanned[i]
	}

	var size int
	for rows.Next() {
		if len(result.Rows) == limit || size > maxResultBytes {
			result.Truncated = true
			break
		}
		if err := rows.Scan(into...); err != nil {
			return nil, err
		}
		row := make([]any, len(columns))
		for i, cell := range scanned {
			row[i], size = renderCell(cell, size)
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	result.RowCount = len(result.Rows)
	result.TookMs = time.Since(started).Milliseconds()
	return result, nil
}

// renderCell turns one scanned value into something JSON can carry, and reports
// the running size so a wide result can be cut off before it is built.
func renderCell(cell any, size int) (any, int) {
	switch typed := cell.(type) {
	case nil:
		return nil, size + 4
	case []byte:
		clipped := typed
		truncated := false
		if len(clipped) > maxBlobBytes {
			clipped, truncated = clipped[:maxBlobBytes], true
		}
		encoded := base64.StdEncoding.EncodeToString(clipped)
		return Blob{Bytes: len(typed), Base64: encoded, Truncated: truncated}, size + len(encoded)
	case string:
		return typed, size + len(typed)
	case time.Time:
		return typed.UTC().Format(time.RFC3339Nano), size + 32
	default:
		return typed, size + 16
	}
}

// SchemaObject is one row of sqlite_master, with a row count for tables.
type SchemaObject struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	Table string `json:"table"`
	SQL   string `json:"sql,omitempty"`
	Rows  *int64 `json:"rows,omitempty"`
}

// Schema describes the database's shape and physical state.
type Schema struct {
	Objects   []SchemaObject `json:"objects"`
	Pragmas   map[string]any `json:"pragmas"`
	SizeBytes int64          `json:"sizeBytes"`
	Integrity []string       `json:"integrity,omitempty"`
}

// SchemaInfo reports the tables and indexes along with the page accounting that
// says whether the file is actually giving space back.
//
// deep adds integrity_check, which reads every page — minutes on a large
// database, so it is never done by default.
func (db *DB) SchemaInfo(ctx context.Context, deep bool) (*Schema, error) {
	rows, err := db.sql.QueryContext(ctx, `
		SELECT type, name, tbl_name, COALESCE(sql, '')
		FROM sqlite_master
		WHERE name NOT LIKE 'sqlite_%'
		ORDER BY type, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	schema := &Schema{Objects: []SchemaObject{}, Pragmas: map[string]any{}}
	for rows.Next() {
		var object SchemaObject
		if err := rows.Scan(&object.Type, &object.Name, &object.Table, &object.SQL); err != nil {
			return nil, err
		}
		schema.Objects = append(schema.Objects, object)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Counted after the cursor is done: SQLite takes one read transaction per
	// connection and nesting a second query inside this one would deadlock on
	// the pool under load.
	rows.Close()
	for i, object := range schema.Objects {
		if object.Type != "table" {
			continue
		}
		var count int64
		// The name comes from sqlite_master, not from the caller, so there is
		// nothing here to inject.
		if err := db.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM "`+object.Name+`"`).Scan(&count); err != nil {
			return nil, fmt.Errorf("count %s: %w", object.Name, err)
		}
		schema.Objects[i].Rows = &count
	}

	var pageCount, pageSize int64
	for _, pragma := range []string{
		"page_count", "page_size", "freelist_count", "auto_vacuum",
		"journal_mode", "synchronous", "user_version", "encoding", "query_only",
	} {
		var value any
		if err := db.sql.QueryRowContext(ctx, `PRAGMA `+pragma).Scan(&value); err != nil {
			return nil, fmt.Errorf("pragma %s: %w", pragma, err)
		}
		if raw, ok := value.([]byte); ok {
			value = string(raw)
		}
		schema.Pragmas[pragma] = value
		switch pragma {
		case "page_count":
			pageCount, _ = value.(int64)
		case "page_size":
			pageSize, _ = value.(int64)
		}
	}
	schema.SizeBytes = pageCount * pageSize

	if deep {
		check, err := db.sql.QueryContext(ctx, `PRAGMA integrity_check`)
		if err != nil {
			return nil, err
		}
		defer check.Close()
		for check.Next() {
			var line string
			if err := check.Scan(&line); err != nil {
				return nil, err
			}
			schema.Integrity = append(schema.Integrity, line)
		}
		if err := check.Err(); err != nil {
			return nil, err
		}
	}
	return schema, nil
}
