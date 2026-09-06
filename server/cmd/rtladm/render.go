package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// maxCell bounds a table column, so one long SQL string cannot push every other
// column off the terminal.
const maxCell = 48

// render prints a result in whatever shape reads best for that op. Anything
// unrecognised falls back to indented JSON, which is always correct if not
// always pretty — that is what keeps the "raw" command useful for ops added to
// the server later than this binary.
func render(op string, raw json.RawMessage) error {
	switch op {
	case "status":
		return renderStatus(raw)
	case "sql":
		return renderSQL(raw)
	case "schema":
		return renderSchema(raw)
	case "logs":
		return renderLogs(raw)
	case "upstream":
		return renderUpstream(raw)
	case "stacks":
		return renderStacks(raw)
	case "ops":
		return renderOps(raw)
	default:
		return printRaw(raw)
	}
}

func printRaw(raw json.RawMessage) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		fmt.Println(string(raw))
		return nil
	}
	return printJSON(value)
}

func renderStatus(raw json.RawMessage) error {
	var status map[string]any
	if err := json.Unmarshal(raw, &status); err != nil {
		return printRaw(raw)
	}
	// Flattened to dotted keys rather than nested: one value per line is what
	// makes the output greppable, which is most of what it is for.
	pairs := map[string]string{}
	flatten("", status, pairs)

	keys := make([]string, 0, len(pairs))
	width := 0
	for key := range pairs {
		keys = append(keys, key)
		width = max(width, len(key))
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Printf("%-*s  %s\n", width, key, pairs[key])
	}
	return nil
}

func flatten(prefix string, value any, out map[string]string) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			flatten(join(prefix, key), child, out)
		}
	case []any:
		if len(typed) == 0 {
			out[prefix] = "[]"
			return
		}
		for i, child := range typed {
			flatten(join(prefix, strconv.Itoa(i)), child, out)
		}
	default:
		out[prefix] = cell(value)
	}
}

func join(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

func renderSQL(raw json.RawMessage) error {
	var result struct {
		Columns   []string `json:"columns"`
		Rows      [][]any  `json:"rows"`
		RowCount  int      `json:"rowCount"`
		Truncated bool     `json:"truncated"`
		TookMs    int64    `json:"tookMs"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return printRaw(raw)
	}
	if len(result.Columns) == 0 {
		fmt.Println("(no columns)")
		return nil
	}

	table := make([][]string, 0, len(result.Rows)+1)
	table = append(table, result.Columns)
	for _, row := range result.Rows {
		rendered := make([]string, len(row))
		for i, value := range row {
			rendered[i] = cell(value)
		}
		table = append(table, rendered)
	}
	printTable(table)

	summary := fmt.Sprintf("\n%d row%s in %dms", result.RowCount, plural(result.RowCount), result.TookMs)
	if result.Truncated {
		summary += " (truncated — raise -limit for more)"
	}
	fmt.Println(summary)
	return nil
}

func renderSchema(raw json.RawMessage) error {
	var schema struct {
		Objects []struct {
			Type  string `json:"type"`
			Name  string `json:"name"`
			Table string `json:"table"`
			Rows  *int64 `json:"rows"`
		} `json:"objects"`
		Pragmas   map[string]any `json:"pragmas"`
		SizeBytes int64          `json:"sizeBytes"`
		Integrity []string       `json:"integrity"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return printRaw(raw)
	}

	table := [][]string{{"TYPE", "NAME", "TABLE", "ROWS"}}
	for _, object := range schema.Objects {
		rows := ""
		if object.Rows != nil {
			rows = strconv.FormatInt(*object.Rows, 10)
		}
		table = append(table, []string{object.Type, object.Name, object.Table, rows})
	}
	printTable(table)

	fmt.Printf("\nfile  %s\n", humanBytes(schema.SizeBytes))
	keys := make([]string, 0, len(schema.Pragmas))
	for key := range schema.Pragmas {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Printf("%-16s %s\n", key, cell(schema.Pragmas[key]))
	}
	if len(schema.Integrity) > 0 {
		fmt.Printf("\nintegrity: %s\n", strings.Join(schema.Integrity, "; "))
	}
	return nil
}

func renderLogs(raw json.RawMessage) error {
	var result struct {
		Records []struct {
			Time  string         `json:"time"`
			Level string         `json:"level"`
			Msg   string         `json:"msg"`
			Attrs map[string]any `json:"attrs"`
		} `json:"records"`
		Returned int `json:"returned"`
		Held     int `json:"held"`
		Capacity int `json:"capacity"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return printRaw(raw)
	}

	for _, record := range result.Records {
		keys := make([]string, 0, len(record.Attrs))
		for key := range record.Attrs {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		attrs := make([]string, 0, len(keys))
		for _, key := range keys {
			attrs = append(attrs, key+"="+cell(record.Attrs[key]))
		}
		fmt.Printf("%s %-5s %s", clockOf(record.Time), record.Level, record.Msg)
		if len(attrs) > 0 {
			fmt.Printf("  %s", strings.Join(attrs, " "))
		}
		fmt.Println()
	}
	fmt.Printf("\n%d of %d records held (buffer holds %d)\n", result.Returned, result.Held, result.Capacity)
	return nil
}

func renderUpstream(raw json.RawMessage) error {
	var result struct {
		Endpoint string          `json:"endpoint"`
		URL      string          `json:"url"`
		Method   string          `json:"method"`
		Bytes    int             `json:"bytes"`
		TookMs   int64           `json:"tookMs"`
		Body     json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return printRaw(raw)
	}
	fmt.Printf("%s %s\n%s in %dms\n\n", result.Method, result.URL, humanBytes(int64(result.Bytes)), result.TookMs)
	return printRaw(result.Body)
}

func renderStacks(raw json.RawMessage) error {
	var result struct {
		Goroutines int    `json:"goroutines"`
		Truncated  bool   `json:"truncated"`
		Stacks     string `json:"stacks"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return printRaw(raw)
	}
	fmt.Printf("%d goroutines\n\n%s", result.Goroutines, result.Stacks)
	if result.Truncated {
		fmt.Println("\n(dump truncated)")
	}
	return nil
}

func renderOps(raw json.RawMessage) error {
	var ops []struct {
		Op      string `json:"op"`
		Summary string `json:"summary"`
		Params  string `json:"params"`
	}
	if err := json.Unmarshal(raw, &ops); err != nil {
		return printRaw(raw)
	}
	for _, op := range ops {
		fmt.Printf("%-10s %s\n", op.Op, op.Summary)
		if op.Params != "" {
			fmt.Printf("%-10s %s\n", "", op.Params)
		}
	}
	return nil
}

// --- shared formatting ---

// cell renders one value from a JSON result. Numbers arrive as float64, so an
// integer count would otherwise print as 1.23891e+06.
func cell(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		if typed == math.Trunc(typed) && math.Abs(typed) < 1e15 {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case map[string]any:
		// A BLOB column, which the server sends as size plus a clipped base64.
		if size, ok := typed["bytes"].(float64); ok {
			if _, isBlob := typed["base64"]; isBlob {
				return fmt.Sprintf("<blob %s>", humanBytes(int64(size)))
			}
		}
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	default:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
}

func printTable(rows [][]string) {
	if len(rows) == 0 {
		return
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for i, value := range row {
			if i < len(widths) {
				widths[i] = max(widths[i], utf8.RuneCountInString(clip(value)))
			}
		}
	}
	for _, row := range rows {
		fields := make([]string, 0, len(row))
		for i, value := range row {
			value = clip(value)
			if i == len(row)-1 {
				fields = append(fields, value) // no trailing padding
				continue
			}
			pad := widths[i] - utf8.RuneCountInString(value)
			fields = append(fields, value+strings.Repeat(" ", max(pad, 0)))
		}
		fmt.Println(strings.TrimRight(strings.Join(fields, "  "), " "))
	}
}

func clip(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	if utf8.RuneCountInString(value) <= maxCell {
		return value
	}
	runes := []rune(value)
	return string(runes[:maxCell-1]) + "…"
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for size := n / unit; size >= unit; size /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// clockOf keeps the time and drops the date, which is the same for nearly every
// record in a tail and costs a third of the line width.
func clockOf(timestamp string) string {
	if _, clock, found := strings.Cut(timestamp, "T"); found {
		if trimmed, _, ok := strings.Cut(clock, "."); ok {
			return trimmed
		}
		return strings.TrimSuffix(clock, "Z")
	}
	return timestamp
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
