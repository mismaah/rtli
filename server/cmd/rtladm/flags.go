package main

import (
	"flag"
	"fmt"
	"io"
	"slices"
	"strings"
)

// commands are the subcommands run understands. Naming them lets the command
// be found wherever it sits on the line, so both of these work:
//
//	rtladm -url http://localhost:8080 status
//	rtladm status -url http://localhost:8080
var commands = []string{"status", "sql", "schema", "logs", "upstream", "stacks", "ops", "raw"}

func splitCommand(args []string) (string, []string, error) {
	for i, arg := range args {
		if slices.Contains(commands, arg) {
			rest := make([]string, 0, len(args)-1)
			rest = append(rest, args[:i]...)
			rest = append(rest, args[i+1:]...)
			return arg, rest, nil
		}
	}
	return "", nil, fmt.Errorf("no command given; expected one of %s (run rtladm help)", strings.Join(commands, ", "))
}

// flagSet is flag.FlagSet with the one behaviour it lacks: flags are accepted
// after positional arguments as well as before, so
//
//	rtladm sql "SELECT 1" -limit 5
//
// works as readily as the other order. Go's flag package stops at the first
// non-flag argument, which for a command whose subject is a long SQL string is
// exactly the wrong place to stop.
type flagSet struct {
	fs   *flag.FlagSet
	rest []string
}

func newFlagSet(name string) *flagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are reported by run, not printed twice
	return &flagSet{fs: fs}
}

func (f *flagSet) String(name, value, usage string) *string { return f.fs.String(name, value, usage) }
func (f *flagSet) Int(name string, value int, usage string) *int {
	return f.fs.Int(name, value, usage)
}
func (f *flagSet) Bool(name string, value bool, usage string) *bool {
	return f.fs.Bool(name, value, usage)
}

func (f *flagSet) parse(args []string) error {
	flags, positional := partition(f.fs, args)
	if err := f.fs.Parse(flags); err != nil {
		return err
	}
	f.rest = append(positional, f.fs.Args()...)
	return nil
}

// positional returns the arguments that were not flags.
func (f *flagSet) positional() []string { return f.rest }

// partition separates flag tokens from positional ones, consuming the value
// that follows any flag which is not a boolean.
func partition(fs *flag.FlagSet, args []string) (flags, positional []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--":
			// Everything after is positional by convention.
			return flags, append(positional, args[i+1:]...)
		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			flags = append(flags, arg)
			name, inline := cutInlineValue(strings.TrimLeft(arg, "-"))
			// A bool flag takes no separate value, and an unknown flag is left
			// for Parse to complain about rather than silently eating the next
			// argument.
			if !inline && !isBool(fs, name) && fs.Lookup(name) != nil && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		default:
			positional = append(positional, arg)
		}
	}
	return flags, positional
}

func cutInlineValue(name string) (string, bool) {
	if before, _, found := strings.Cut(name, "="); found {
		return before, true
	}
	return name, false
}

func isBool(fs *flag.FlagSet, name string) bool {
	found := fs.Lookup(name)
	if found == nil {
		return false
	}
	asBool, ok := found.Value.(interface{ IsBoolFlag() bool })
	return ok && asBool.IsBoolFlag()
}
