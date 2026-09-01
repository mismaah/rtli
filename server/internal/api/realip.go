package api

import (
	"net"
	"net/http"
	"strings"
)

// RealIP resolves the address to attribute a request to.
//
// This server is intended to run behind a Cloudflare Tunnel, where every request
// arrives from `cloudflared` on the loopback interface. RemoteAddr is therefore
// the *tunnel's* address for every visitor alike, which would make a per-client
// limit either meaningless or a way to lock out everybody at once. Cloudflare
// supplies the true client in `CF-Connecting-IP`.
//
// Headers are only trusted when trustProxy is set, and it must only be set when
// the sole route to this server is through that proxy — otherwise anyone can
// mint an identity per request and walk straight past the cap. On a home server
// exposed exclusively by tunnel that holds; on a directly reachable port it does
// not.
func RealIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if ip := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); ip != "" {
			return ip
		}
		// X-Forwarded-For is a chain; the client is the leftmost entry.
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			if first, _, found := strings.Cut(forwarded, ","); found || first != "" {
				if ip := strings.TrimSpace(first); ip != "" {
					return ip
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
