package rtl

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// call describes one upstream endpoint by name, so it can be asked for by name
// rather than by URL. Diagnosis needs to see what RTL actually returned; it
// does not need this client to become an open proxy.
type call struct {
	Method     string
	Path       string
	NeedsRoute bool
}

var calls = map[string]call{
	"routedetails":    {http.MethodGet, "/booking/v2/bus/routedetails", false},
	"roadshape":       {http.MethodPost, "/booking/v2/bus/roadshape", true},
	"livecoordinates": {http.MethodPost, "/booking/v1/bus/livecoordinates", true},
	"etas":            {http.MethodPost, "/gps-engine/eta/all-stops-of-route", true},
}

// Endpoints lists the names FetchRaw accepts, in a stable order.
func Endpoints() []string {
	return []string{"routedetails", "roadshape", "livecoordinates", "etas"}
}

// RawResult is one upstream response, undecoded.
type RawResult struct {
	Endpoint string          `json:"endpoint"`
	URL      string          `json:"url"`
	Method   string          `json:"method"`
	Bytes    int             `json:"bytes"`
	TookMs   int64           `json:"tookMs"`
	Body     json.RawMessage `json:"body"`
}

// FetchRaw calls one named endpoint and returns the body exactly as it arrived.
//
// The parsed responses this client normally returns cannot show a field RTL has
// renamed or dropped — the struct simply comes back zeroed, which reads as "no
// data" rather than "the shape changed". This is the view that tells them apart,
// and it is taken from the server's own network position, which is the other
// half of the question when something upstream stops working.
func (c *Client) FetchRaw(ctx context.Context, endpoint, routeCode string) (*RawResult, error) {
	target, ok := calls[endpoint]
	if !ok {
		return nil, fmt.Errorf("unknown endpoint %q; try one of %v", endpoint, Endpoints())
	}
	var body any
	if target.NeedsRoute {
		if routeCode == "" {
			return nil, fmt.Errorf("endpoint %q needs a route code", endpoint)
		}
		body = routeCodeBody{routeCode}
	}

	started := time.Now()
	payload, err := c.send(ctx, endpoint, target.Method, target.Path, body)
	if err != nil {
		return nil, err
	}
	result := &RawResult{
		Endpoint: endpoint,
		URL:      c.BaseURL + target.Path,
		Method:   target.Method,
		Bytes:    len(payload),
		TookMs:   time.Since(started).Milliseconds(),
		Body:     json.RawMessage(payload),
	}
	// A body that is not JSON would make the whole response unencodable, and
	// that body is exactly what a caller diagnosing a bad response wants to
	// see, so hand it back as a string instead of failing.
	if !json.Valid(payload) {
		quoted, _ := json.Marshal(string(payload))
		result.Body = quoted
	}
	return result, nil
}
