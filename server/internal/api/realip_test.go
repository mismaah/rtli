package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRealIP(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		headers    map[string]string
		trustProxy bool
		want       string
	}{
		{
			name:       "direct connection uses RemoteAddr",
			remoteAddr: "203.0.113.7:54321",
			trustProxy: false,
			want:       "203.0.113.7",
		},
		{
			// The whole point: behind the tunnel every visitor shares this.
			name:       "untrusted headers are ignored",
			remoteAddr: "127.0.0.1:40000",
			headers:    map[string]string{"CF-Connecting-IP": "203.0.113.7"},
			trustProxy: false,
			want:       "127.0.0.1",
		},
		{
			name:       "trusted CF-Connecting-IP wins",
			remoteAddr: "127.0.0.1:40000",
			headers:    map[string]string{"CF-Connecting-IP": "203.0.113.7"},
			trustProxy: true,
			want:       "203.0.113.7",
		},
		{
			name:       "falls back to the leftmost X-Forwarded-For",
			remoteAddr: "127.0.0.1:40000",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.7, 70.41.3.18"},
			trustProxy: true,
			want:       "203.0.113.7",
		},
		{
			name:       "trusted but headerless falls back to RemoteAddr",
			remoteAddr: "127.0.0.1:40000",
			trustProxy: true,
			want:       "127.0.0.1",
		},
		{
			name:       "IPv6 RemoteAddr is unwrapped",
			remoteAddr: "[2001:db8::1]:40000",
			trustProxy: false,
			want:       "2001:db8::1",
		},
		{
			name:       "blank header is not treated as an identity",
			remoteAddr: "127.0.0.1:40000",
			headers:    map[string]string{"CF-Connecting-IP": "   "},
			trustProxy: true,
			want:       "127.0.0.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tt.remoteAddr
			for k, v := range tt.headers {
				r.Header.Set(k, v)
			}
			if got := RealIP(r, tt.trustProxy); got != tt.want {
				t.Errorf("RealIP = %q, want %q", got, tt.want)
			}
		})
	}
}
