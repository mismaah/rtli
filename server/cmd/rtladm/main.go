// Command rtladm calls the rtld diagnostics endpoint.
//
// Every request is signed with an SSH key the server has been given the public
// half of, so there is no shared secret to leak and no session to keep. The
// endpoint is read-only: this can look at anything and change nothing.
//
//	rtladm status
//	rtladm sql "SELECT route_code, COUNT(*) FROM bus_fix GROUP BY 1"
//	rtladm logs -level warn
//	rtladm upstream livecoordinates -route 133
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/mismaah/rtl-improved/server/internal/api"
	"github.com/mismaah/rtl-improved/server/internal/sshsig"
)

const defaultURL = "https://rtli-api.mismaah.com"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "rtladm: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		usage()
		return nil
	}

	command, rest, err := splitCommand(args)
	if err != nil {
		return err
	}
	flags := newFlagSet(command)
	url := flags.String("url", envOr("RTLD_ADMIN_URL", defaultURL), "server base URL")
	keyPath := flags.String("key", envOr("RTLD_ADMIN_IDENTITY", defaultKeyPath()), "private key to sign with")
	asJSON := flags.Bool("json", false, "print the raw JSON result")
	userAgent := flags.String("user-agent", envOr("RTLD_ADMIN_UA", "rtladm/1"), "User-Agent to send")

	op, params, err := build(command, flags, rest)
	if err != nil {
		return err
	}

	signer, err := loadSigner(*keyPath)
	if err != nil {
		return err
	}

	result, err := post(*url, *userAgent, signer, op, params)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(result)
	}
	return render(op, result)
}

// build turns a command line into an op and its params.
func build(command string, flags *flagSet, args []string) (string, map[string]any, error) {
	switch command {
	case "status", "stacks", "ops":
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		return command, nil, nil

	case "sql":
		limit := flags.Int("limit", 0, "maximum rows to return")
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		query := strings.Join(flags.positional(), " ")
		if query == "" {
			return "", nil, errors.New(`sql needs a query, e.g. rtladm sql "SELECT COUNT(*) FROM bus_fix"`)
		}
		params := map[string]any{"query": query}
		if *limit > 0 {
			params["limit"] = *limit
		}
		return "sql", params, nil

	case "schema":
		deep := flags.Bool("deep", false, "run integrity_check, which reads every page")
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		return "schema", map[string]any{"deep": *deep}, nil

	case "logs":
		limit := flags.Int("n", 100, "how many records")
		level := flags.String("level", "", "minimum level: debug, info, warn, error")
		contains := flags.String("contains", "", "only records mentioning this")
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		return "logs", map[string]any{"limit": *limit, "level": *level, "contains": *contains}, nil

	case "upstream":
		route := flags.String("route", "", "route code, for endpoints that need one")
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		positional := flags.positional()
		if len(positional) != 1 {
			return "", nil, errors.New("upstream needs one endpoint: routedetails, roadshape, livecoordinates or etas")
		}
		return "upstream", map[string]any{"endpoint": positional[0], "routeCode": *route}, nil

	case "raw":
		if err := flags.parse(args); err != nil {
			return "", nil, err
		}
		positional := flags.positional()
		if len(positional) == 0 {
			return "", nil, errors.New(`raw needs an op, e.g. rtladm raw status '{}'`)
		}
		var params map[string]any
		if len(positional) > 1 && strings.TrimSpace(positional[1]) != "" {
			if err := json.Unmarshal([]byte(positional[1]), &params); err != nil {
				return "", nil, fmt.Errorf("params must be a JSON object: %w", err)
			}
		}
		return positional[0], params, nil

	default:
		return "", nil, fmt.Errorf("unknown command %q; run rtladm help", command)
	}
}

// post signs one envelope and sends it.
func post(baseURL, userAgent string, signer ssh.Signer, op string, params map[string]any) (json.RawMessage, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	envelope := map[string]any{
		"op":    op,
		"ts":    time.Now().UnixMilli(),
		"nonce": base64.StdEncoding.EncodeToString(nonce),
	}
	if len(params) > 0 {
		envelope["params"] = params
	}
	// The signature covers these exact bytes, so they are what must be sent —
	// re-encoding the envelope anywhere between here and the wire would break it.
	body, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	armored, err := sshsig.Sign(signer, api.AdminNamespace, body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimSuffix(baseURL, "/")+api.AdminPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	// A header cannot carry a newline; the armour is base64 either way.
	req.Header.Set(api.AdminSignatureHeader, strings.ReplaceAll(string(armored), "\n", ""))

	res, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}

	var decoded struct {
		OK     bool            `json:"ok"`
		Error  string          `json:"error"`
		Result json.RawMessage `json:"result"`
		TookMs int64           `json:"tookMs"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		// Cloudflare's bot protection answers unusual clients with an HTML
		// challenge rather than a rejection the server ever sees.
		if res.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("403 before reaching the server, most likely Cloudflare bot protection; "+
				"try -user-agent %q", "curl/8.7.1")
		}
		return nil, fmt.Errorf("status %d: %s", res.StatusCode, strings.TrimSpace(firstLine(payload)))
	}
	if !decoded.OK {
		if decoded.Error == "" {
			decoded.Error = "status " + res.Status
		}
		return nil, errors.New(decoded.Error)
	}
	return decoded.Result, nil
}

// --- signing ---

func defaultKeyPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "id_rsa"
	}
	return filepath.Join(home, ".ssh", "id_rsa")
}

// loadSigner reads the private key, falling back to ssh-agent when the key on
// disk is passphrase-protected — which is the case worth handling, since asking
// for a passphrase on every diagnostic call would make this unusable.
func loadSigner(path string) (ssh.Signer, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	signer, err := ssh.ParsePrivateKey(raw)
	if err == nil {
		return signer, nil
	}
	var needsPassphrase *ssh.PassphraseMissingError
	if !errors.As(err, &needsPassphrase) {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return agentSigner(path)
}

func agentSigner(keyPath string) (ssh.Signer, error) {
	socket := os.Getenv("SSH_AUTH_SOCK")
	if socket == "" {
		return nil, fmt.Errorf("%s needs a passphrase and no ssh-agent is running; run: ssh-add %s", keyPath, keyPath)
	}
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return nil, fmt.Errorf("connect to ssh-agent: %w", err)
	}
	defer conn.Close()

	public, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		return nil, fmt.Errorf("read %s.pub, needed to pick the right agent key: %w", keyPath, err)
	}
	wanted, _, _, _, err := ssh.ParseAuthorizedKey(public)
	if err != nil {
		return nil, fmt.Errorf("parse %s.pub: %w", keyPath, err)
	}

	signers, err := agent.NewClient(conn).Signers()
	if err != nil {
		return nil, fmt.Errorf("list agent keys: %w", err)
	}
	for _, signer := range signers {
		if bytes.Equal(signer.PublicKey().Marshal(), wanted.Marshal()) {
			return signer, nil
		}
	}
	return nil, fmt.Errorf("%s is not loaded in the agent; run: ssh-add %s", keyPath, keyPath)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func firstLine(payload []byte) string {
	line, _, _ := strings.Cut(string(payload), "\n")
	if len(line) > 200 {
		line = line[:200] + "…"
	}
	return line
}

func printJSON(value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func usage() {
	fmt.Println(`rtladm — read-only diagnostics for the rtld server.

Usage:
  rtladm [flags] <command> [args]

Commands:
  status                     runtime, cache, stream and store state
  sql <query>                run a read-only query against the store
  schema [-deep]             tables, indexes, row counts, page accounting
  logs [-n] [-level] [-contains]   tail the server's in-memory log
  upstream <endpoint> [-route]     call RTL from the server and show the raw body
  stacks                     full goroutine dump
  ops                        list what the server supports
  raw <op> [params json]     send any op, for anything not listed above

Flags:
  -url          server base URL          (RTLD_ADMIN_URL, default ` + defaultURL + `)
  -key          private key to sign with (RTLD_ADMIN_IDENTITY, default ~/.ssh/id_rsa)
  -json         print the raw JSON result
  -user-agent   User-Agent to send       (RTLD_ADMIN_UA)

Examples:
  rtladm status
  rtladm sql -limit 20 "SELECT route_code, COUNT(*) FROM bus_fix GROUP BY 1 ORDER BY 2 DESC"
  rtladm logs -level warn -contains prune
  rtladm upstream livecoordinates -route 133
  rtladm -url http://localhost:8080 schema`)
}
