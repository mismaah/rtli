package poller

import (
	"context"
	"encoding/json"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/store"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// pollRoute fetches one route's positions, corrects and folds them into the
// running tracks, publishes what changed, and records the movement.
func (p *Poller) pollRoute(ctx context.Context, routeCode string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	live, err := p.rtl.LiveCoordinates(ctx, routeCode)
	if err != nil {
		// Routine: routes report nothing all the time. Debug, not warn.
		p.log.Debug("live poll failed", "routeCode", routeCode, "err", err)
		return
	}

	now := time.Now()
	nowMs := now.UnixMilli()

	p.mu.RLock()
	lines := p.shapes[routeCode]
	p.mu.RUnlock()

	// Snap before inferring: a position pulled back onto the road is a steadier
	// one to take a bearing from, so the arrow stops swinging with the fix.
	//
	// The reading as RTL gave it is kept first, because snapping overwrites the
	// bus in place and the recorder needs the original: a snap can only be
	// judged against what it was correcting.
	buses := live.BusList
	reported := make(map[string]geo.LatLng, len(buses))
	offsets := make(map[string]float64, len(buses))
	for i := range buses {
		reported[buses[i].BusCode] = geo.LatLng{Lat: buses[i].Latitude, Lng: buses[i].Longitude}
		if len(lines) == 0 {
			continue
		}
		snapped := track.Snap(
			geo.LatLng{Lat: buses[i].Latitude, Lng: buses[i].Longitude},
			lines, track.FullSnapM, track.NoSnapM)
		offsets[buses[i].BusCode] = snapped.OffsetM
		buses[i].Latitude, buses[i].Longitude = snapped.Lat, snapped.Lng
	}

	p.mu.Lock()
	previous := p.tracks[routeCode]
	updated := track.Update(previous, buses, nowMs)
	for code, t := range updated {
		t.OffsetM = offsets[code]
	}
	p.tracks[routeCode] = updated
	p.mu.Unlock()

	p.publishChanges(routeCode, previous, updated)
	p.record(ctx, routeCode, previous, updated, reported, now)
}

// publishChanges emits one event per bus that actually moved.
//
// Per-bus deltas rather than whole snapshots, because the measured feed updates
// each bus independently and staggered: in any given second typically one bus of
// four has a new position, so a full snapshot would be mostly redundant.
func (p *Poller) publishChanges(routeCode string, previous, updated map[string]*track.Track) {
	for busCode, current := range updated {
		prior, existed := previous[busCode]
		if existed && prior.UpdatedAt == current.UpdatedAt {
			continue
		}
		if existed && samePosition(prior, current) && prior.Heading == current.Heading {
			continue
		}
		if payload, err := json.Marshal(current); err == nil {
			p.hub.Publish("bus", routeCode, payload)
		}
	}

	// A bus that left the feed has gone out of service; clients must drop it
	// rather than leave a ghost parked on the map.
	for busCode := range previous {
		if _, still := updated[busCode]; still {
			continue
		}
		if payload, err := json.Marshal(map[string]string{"busCode": busCode}); err == nil {
			p.hub.Publish("bus-gone", routeCode, payload)
		}
	}
}

func samePosition(a, b *track.Track) bool {
	return a.Lat == b.Lat && a.Lng == b.Lng
}

// record persists positions where the bus demonstrably moved.
//
// Only real movement is stored: a parked bus re-reporting the same coordinates
// every 11 seconds would be most of the table and teaches nothing.
func (p *Poller) record(ctx context.Context, routeCode string, previous, updated map[string]*track.Track,
	reported map[string]geo.LatLng, now time.Time) {
	if p.store == nil {
		return
	}

	fixes := make([]store.Fix, 0, len(updated))
	for busCode, current := range updated {
		prior, existed := previous[busCode]
		if existed && current.MovedAt == prior.MovedAt {
			continue // Inside the jitter radius; nothing happened.
		}
		// Copies, not pointers into the live track: the map entry keeps being
		// mutated by later polls, and a Fix must describe this moment.
		offset, snapLat, snapLng := current.OffsetM, current.Lat, current.Lng
		// A bus tracked from a snapshot rather than this poll has no reading of
		// its own here; the corrected position is the only one there is.
		raw, ok := reported[busCode]
		if !ok {
			raw = geo.LatLng{Lat: current.Lat, Lng: current.Lng}
		}
		fixes = append(fixes, store.Fix{
			RouteCode: routeCode,
			BusCode:   busCode,
			AtMs:      current.UpdatedAt,
			Lat:       raw.Lat,
			Lng:       raw.Lng,
			SnapLat:   &snapLat,
			SnapLng:   &snapLng,
			OffsetM:   &offset,
			Heading:   current.Heading,
			SpeedMps:  current.SpeedMps,
		})
	}
	if len(fixes) == 0 {
		return
	}

	if err := p.store.InsertFixes(ctx, fixes); err != nil {
		p.log.Warn("could not record fixes", "routeCode", routeCode, "err", err)
		return
	}
	if err := p.store.RecordActivity(ctx, ServiceDate(now), routeCode, now.UnixMilli(), len(fixes)); err != nil {
		p.log.Warn("could not record activity", "routeCode", routeCode, "err", err)
	}
}

// pollEtas refreshes arrivals for every route and publishes what changed.
func (p *Poller) pollEtas(ctx context.Context) {
	ticker := time.NewTicker(EtaInterval)
	defer ticker.Stop()

	previous := make(map[string]string) // routeCode -> encoded payload

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if !inServiceHours(now) {
				continue
			}
			watched := p.hub.RouteSubscribers()
			for routeCode, count := range watched {
				if count == 0 {
					continue
				}
				etas, err := p.rtl.StopEtas(ctx, routeCode)
				if err != nil {
					continue
				}
				payload, err := json.Marshal(etas)
				if err != nil {
					continue
				}
				// Republishing an unchanged countdown would wake every client
				// to tell it nothing.
				if previous[routeCode] == string(payload) {
					continue
				}
				previous[routeCode] = string(payload)
				p.hub.Publish("etas", routeCode, payload)
			}
		}
	}
}

// ServiceDate is the Malé civil date, matching serviceDate() in src/lib/time.ts.
// Malé is UTC+05:00 with no DST, ever.
func ServiceDate(now time.Time) string {
	return now.UTC().Add(5 * time.Hour).Format("2006-01-02")
}
