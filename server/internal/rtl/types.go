// Package rtl is a client for RTL's public, unauthenticated bus API.
//
// The types here mirror src/api/rtl.ts field for field, plus the fields the
// client happens to ignore, because this server re-serves the same JSON shape
// and anything dropped here would be dropped from the client's view too.
//
// Note the non-standard port 4455, which some restrictive networks block. That
// blocking is one of the reasons this server exists, so its own errors must stay
// legible rather than silently retrying forever.
package rtl

import (
	"encoding/json"
	"strconv"
)

// Timing is one departure. Order is a *trip number* shared across every stop on
// the route, so grouping by it reconstructs a GTFS-style timetable.
type Timing struct {
	Order  int    `json:"order"`
	Timing string `json:"timing"`
}

// Stop is one stop on one route. Latitude and Longitude arrive as strings.
type Stop struct {
	ID        int      `json:"id"`
	Order     int      `json:"order"`
	Name      string   `json:"name"`
	DvName    string   `json:"dvname"`
	Code      string   `json:"code"`
	Latitude  string   `json:"latitude"`
	Longitude string   `json:"longitude"`
	Timings   []Timing `json:"timings"`
}

// LatLng parses the string coordinates, reporting whether both were usable.
func (s Stop) LatLng() (lat, lng float64, ok bool) {
	lat, err := strconv.ParseFloat(s.Latitude, 64)
	if err != nil {
		return 0, 0, false
	}
	lng, err = strconv.ParseFloat(s.Longitude, 64)
	if err != nil {
		return 0, 0, false
	}
	return lat, lng, true
}

// Route is one bus route. Code is a numeric id ("133"); RouteNumber is "R1".
// Confusing these is the single easiest mistake to make against this API — the
// live endpoints want Code, and the ETA rows return RouteNumber as null.
type Route struct {
	ID                 int      `json:"id"`
	Code               string   `json:"code"`
	Name               string   `json:"name"`
	DvName             string   `json:"dvname"`
	RouteNumber        string   `json:"routeNumber"`
	BusRouteStopList   []Stop   `json:"busRouteStopList"`
	StartStationCode   string   `json:"startStationCode"`
	EndStationCode     string   `json:"endStationCode"`
	StartStationName   string   `json:"startStationName"`
	EndStationName     string   `json:"endStationName"`
	DvStartStationName *string  `json:"dvstartStationName"`
	DvEndStationName   *string  `json:"dvendStationName"`
	DepotName          *string  `json:"depotName"`
	DvDepotName        *string  `json:"dvdepotName"`
	DepotCode          *string  `json:"depotCode"`
	Color              *string  `json:"color"`
	IsMiniBusRoute     int      `json:"isMiniBusRoute"`
	Fare               *float64 `json:"fare"`
	IsDistanceFareType int      `json:"isDistanceFareType"`
}

// RouteDetails is the routedetails response. AtollRouteResponse covers other
// atolls and is preserved verbatim rather than modelled, since this app is
// Greater Malé only and the client ignores it.
type RouteDetails struct {
	RouteResponse      []Route         `json:"routeResponse"`
	AtollRouteResponse json.RawMessage `json:"atollRouteResponse,omitempty"`
}

// Bus is a live position. This is the entire payload: no timestamp, no heading,
// no speed. Everything else the app shows about a bus is inferred from a series
// of these.
type Bus struct {
	BusCode     string  `json:"busCode"`
	PlateNumber string  `json:"plateNumber"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
}

type LiveCoordinates struct {
	BusList []Bus `json:"busList"`
}

// StopEta is one predicted arrival. Eta is free text: "5 Minutes " (with the
// trailing space), "Entering the station", or "Send in 5 minutes".
type StopEta struct {
	Eta         string  `json:"eta"`
	VehicleCode string  `json:"vehicleCode"`
	StopName    string  `json:"stopName"`
	StopCode    string  `json:"stopCode"`
	StopOrder   int     `json:"stopOrder"`
	RouteCode   string  `json:"routeCode"`
	RouteNumber *string `json:"routeNumber"`
	RouteName   string  `json:"routeName"`
	Destination string  `json:"destination"`
	Direction   string  `json:"direction"`
}

// StopsEta is the ETA response. Outbound has been null in every capture, but is
// handled rather than assumed away.
type StopsEta struct {
	InboundStopsETAList  []StopEta `json:"inboundStopsETAList"`
	OutboundStopsETAList []StopEta `json:"outboundStopsETAList"`
}

// All returns inbound and outbound rows together.
func (s StopsEta) All() []StopEta {
	out := make([]StopEta, 0, len(s.InboundStopsETAList)+len(s.OutboundStopsETAList))
	out = append(out, s.InboundStopsETAList...)
	return append(out, s.OutboundStopsETAList...)
}

// RoadShape is a route's geometry, passed through as raw GeoJSON.
type RoadShape struct {
	RoadShape json.RawMessage `json:"roadShape"`
}
