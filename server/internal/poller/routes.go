package poller

import (
	"context"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/geo"
)

// loadRoutes discovers the route list and each route's geometry.
//
// Geometry is fetched once and kept: it never changes, and it is what lets a
// reported position be pulled back onto the road before a heading is taken from
// it. Without it the arrows would swing with the GPS.
func (p *Poller) loadRoutes(ctx context.Context) error {
	details, err := p.rtl.RouteDetails(ctx)
	if err != nil {
		return err
	}

	codes := make([]string, 0, len(details.RouteResponse))
	for _, route := range details.RouteResponse {
		if route.Code == "" {
			continue
		}
		codes = append(codes, route.Code)
	}
	p.routes.Store(&codes)
	p.log.Info("routes loaded", "count", len(codes))

	for _, code := range codes {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		shape, err := p.rtl.RoadShape(ctx, code)
		if err != nil {
			// A route without geometry still tracks; its positions simply are
			// not corrected. Better than refusing to run.
			p.log.Warn("no geometry for route; positions will not be snapped",
				"routeCode", code, "err", err)
			continue
		}
		lines := geo.Polylines(shape.RoadShape)
		p.mu.Lock()
		p.shapes[code] = lines
		p.mu.Unlock()
	}
	return nil
}

func (p *Poller) refreshRoutesDaily(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := p.loadRoutes(ctx); err != nil {
				p.log.Warn("daily route refresh failed; keeping previous list", "err", err)
			}
		}
	}
}

// Routes returns the discovered route codes.
func (p *Poller) Routes() []string {
	return *p.routes.Load()
}
