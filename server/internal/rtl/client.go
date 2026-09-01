package rtl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// DefaultBaseURL is RTL's booking API. The port is not a typo.
const DefaultBaseURL = "https://bo.rtl.mv:4455/maldives/api"

// Error is any failure reaching or decoding an upstream response. Callers
// distinguish it so a route that simply is not reporting never looks like an
// outage.
type Error struct {
	Op     string
	Status int
	Err    error
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("rtl %s: upstream returned %d", e.Op, e.Status)
	}
	return fmt.Sprintf("rtl %s: %v", e.Op, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// Client talks to RTL. It is safe for concurrent use and holds keep-alive
// connections open, which matters: the poller makes a few requests a second and
// a fresh TLS handshake each time would cost more than the request.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// NewClient returns a Client with timeouts and a connection pool sized for the
// poller's fan-out across 15 routes.
func NewClient(baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	transport := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 8 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &Client{
		BaseURL: baseURL,
		HTTP:    &http.Client{Transport: transport, Timeout: 15 * time.Second},
	}
}

func (c *Client) do(ctx context.Context, op, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return &Error{Op: op, Err: err}
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return &Error{Op: op, Err: err}
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		return &Error{Op: op, Err: err}
	}
	defer func() {
		// Drain before closing so the connection returns to the pool.
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		_ = res.Body.Close()
	}()

	if res.StatusCode != http.StatusOK {
		return &Error{Op: op, Status: res.StatusCode}
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return &Error{Op: op, Err: err}
	}
	return nil
}

type routeCodeBody struct {
	RouteCode string `json:"routeCode"`
}

// RouteDetails fetches routes, stops, coordinates and timetables.
//
// RTL returns only departures still to come, so a response read in the evening
// is missing the whole morning. Completing that picture is the store's job.
func (c *Client) RouteDetails(ctx context.Context) (*RouteDetails, error) {
	var out RouteDetails
	if err := c.do(ctx, "routedetails", http.MethodGet, "/booking/v2/bus/routedetails", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RoadShape fetches one route's geometry. routeCode is the numeric id.
func (c *Client) RoadShape(ctx context.Context, routeCode string) (*RoadShape, error) {
	var out RoadShape
	if err := c.do(ctx, "roadshape", http.MethodPost, "/booking/v2/bus/roadshape", routeCodeBody{routeCode}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LiveCoordinates fetches current bus positions for one route.
//
// Measured: each bus's position advances on a ~11 s cycle and buses are
// staggered against each other, so polling faster than that yields no new
// information — only a shorter wait before a change is noticed.
func (c *Client) LiveCoordinates(ctx context.Context, routeCode string) (*LiveCoordinates, error) {
	var out LiveCoordinates
	if err := c.do(ctx, "livecoordinates", http.MethodPost, "/booking/v1/bus/livecoordinates", routeCodeBody{routeCode}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// StopEtas fetches real-time arrivals for every stop on one route.
func (c *Client) StopEtas(ctx context.Context, routeCode string) (*StopsEta, error) {
	var out StopsEta
	if err := c.do(ctx, "etas", http.MethodPost, "/gps-engine/eta/all-stops-of-route", routeCodeBody{routeCode}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
