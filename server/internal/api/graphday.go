package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

// MaxPlanAheadDays is how far ahead /v1/graph?date= will answer. A week covers
// every day type, and past it a stand-in is a guess about a timetable RTL may
// well have changed by then.
const MaxPlanAheadDays = 7

// errNoTimetable means nothing captured can stand in for the day asked about.
var errNoTimetable = errors.New("no timetable for that day")

// DayGraph is a graph for a day other than today: RTL's own shape, as
// /v1/graph serves it, plus where its departures came from.
type DayGraph struct {
	rtl.RouteDetails
	Timetable DayTimetable `json:"timetable"`
}

// DayTimetable says which captured day a DayGraph's departures were taken from.
type DayTimetable struct {
	// ServiceDate is the day asked about.
	ServiceDate string `json:"serviceDate"`
	// From is the captured day that supplied the times. The same as ServiceDate
	// only once that day has itself been seen whole, which for a day still to
	// come it never has.
	From string `json:"from"`
}

// handleGraphForDay serves /v1/graph?date=YYYY-MM-DD for a day other than
// today, so a rider can plan tomorrow's trip tonight.
//
// RTL only ever publishes what is left of today, so another day's departures
// can only come from the timetable book: that day's own capture if there is
// one, otherwise the nearest complete day of the same type. Routes and stops
// are today's, which they effectively always are.
func (s *Server) handleGraphForDay(w http.ResponseWriter, r *http.Request, date string) {
	if !validPlanDate(date, time.Now()) {
		writeError(w, r, http.StatusBadRequest, "date must be YYYY-MM-DD, from today up to a week ahead")
		return
	}
	if s.timetables == nil {
		writeError(w, r, http.StatusNotFound, errNoTimetable.Error())
		return
	}
	payload, _, err := s.graph.Get(r.Context(), graphKey+":"+date, func(ctx context.Context) (json.RawMessage, error) {
		return s.loadGraphForDay(ctx, date)
	})
	if errors.Is(err, errNoTimetable) {
		writeError(w, r, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		s.fail(w, r, "graph-day", err)
		return
	}
	// The day's timetable only changes when a closer stand-in is captured,
	// which happens once a day at most.
	writeRaw(w, r, "public, max-age=900", payload)
}

func (s *Server) loadGraphForDay(ctx context.Context, date string) (json.RawMessage, error) {
	base, err := s.graphPayload(ctx)
	if err != nil {
		return nil, err
	}
	var details rtl.RouteDetails
	if err := json.Unmarshal(base, &details); err != nil {
		return nil, err
	}
	// Other atolls are ignored by the client; no reason to send them twice.
	details.AtollRouteResponse = nil
	day, source, ok := s.timetables.Day(ctx, date, details)
	if !ok {
		return nil, errNoTimetable
	}
	return json.Marshal(DayGraph{
		RouteDetails: day,
		Timetable:    DayTimetable{ServiceDate: date, From: source.Date},
	})
}

// maleToday is the Malé calendar date at now.
func maleToday(now time.Time) string {
	return now.UTC().Add(store.MaleOffset).Format(time.DateOnly)
}

// validPlanDate reports whether date is a well-formed day from today up to
// MaxPlanAheadDays ahead, in Malé.
func validPlanDate(date string, now time.Time) bool {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return false
	}
	today, _ := time.Parse(time.DateOnly, maleToday(now))
	return !day.Before(today) && !day.After(today.AddDate(0, 0, MaxPlanAheadDays))
}
