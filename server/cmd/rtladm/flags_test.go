package main

import (
	"strings"
	"testing"
)

func TestSplitCommandFindsTheCommandAnywhere(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		command string
		rest    string
	}{
		{[]string{"status"}, "status", ""},
		{[]string{"-url", "http://x", "status"}, "status", "-url http://x"},
		{[]string{"status", "-url", "http://x"}, "status", "-url http://x"},
		{[]string{"sql", "SELECT 1", "-limit", "5"}, "sql", "SELECT 1 -limit 5"},
	} {
		command, rest, err := splitCommand(tc.args)
		if err != nil {
			t.Fatalf("%v: %v", tc.args, err)
		}
		if command != tc.command || strings.Join(rest, " ") != tc.rest {
			t.Errorf("%v -> %q %v, want %q %q", tc.args, command, rest, tc.command, tc.rest)
		}
	}

	if _, _, err := splitCommand([]string{"-url", "http://x"}); err == nil {
		t.Error("a line with no command was accepted")
	}
}

// Go's flag package stops at the first positional, which for "sql <a long
// query>" is the worst possible place to stop.
func TestFlagsAreAcceptedEitherSideOfPositionals(t *testing.T) {
	query := "SELECT route_code FROM bus_fix"
	for _, args := range [][]string{
		{"-limit", "5", "-json", query},
		{query, "-limit", "5", "-json"},
		{"-limit=5", query, "-json"},
		{query, "-limit=5", "-json"},
	} {
		flags := newFlagSet("sql")
		asJSON := flags.Bool("json", false, "")
		limit := flags.Int("limit", 0, "")
		if err := flags.parse(args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if *limit != 5 || !*asJSON {
			t.Errorf("%v -> limit=%d json=%v, want 5/true", args, *limit, *asJSON)
		}
		if got := strings.Join(flags.positional(), " "); got != query {
			t.Errorf("%v -> positional %q, want %q", args, got, query)
		}
	}
}

// Everything after "--" is the caller's, however much it looks like a flag.
func TestDoubleDashEndsFlags(t *testing.T) {
	flags := newFlagSet("sql")
	limit := flags.Int("limit", 0, "")
	if err := flags.parse([]string{"-limit", "3", "--", "-not-a-flag"}); err != nil {
		t.Fatal(err)
	}
	if *limit != 3 {
		t.Errorf("limit = %d, want 3", *limit)
	}
	if got := strings.Join(flags.positional(), " "); got != "-not-a-flag" {
		t.Errorf("positional = %q", got)
	}
}

func TestUnknownFlagIsReported(t *testing.T) {
	flags := newFlagSet("sql")
	flags.Int("limit", 0, "")
	if err := flags.parse([]string{"-limt", "5"}); err == nil {
		t.Error("a mistyped flag was accepted")
	}
}
