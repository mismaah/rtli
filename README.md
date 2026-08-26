# RTL Improved

A mobile-first trip planner for RTL's Greater Malé bus network. Tell it where
you're going and it works out which bus to take, where to walk, when to board and
when you'll arrive — with live bus positions and real-time arrivals.

RTL's own site maps the routes but has no journey planner, so this fills that gap.
Covers the 15 Greater Malé routes (Malé, Hulhulé/airport, Hulhumalé and Villimalé).

## Running it

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm build          # production PWA into dist/
pnpm test           # planner + parsing tests against a real API fixture
pnpm smoke          # hit all four RTL endpoints for all 15 routes
pnpm preview & pnpm e2e   # drive the built app in a mobile viewport, online and offline
```

## How it works

### The data

Four public RTL endpoints, all unauthenticated and served with
`Access-Control-Allow-Origin: *`, so they're called straight from the browser with
no proxy and no API key. They live on port **4455**, which some restrictive
networks block — the app reports that plainly rather than hanging.

| Endpoint | What it gives |
|---|---|
| `booking/v2/bus/routedetails` | Routes, stops, coordinates and timetables |
| `booking/v2/bus/roadshape` | GeoJSON geometry for one route |
| `booking/v1/bus/livecoordinates` | Where each bus is right now |
| `gps-engine/eta/all-stops-of-route` | Real-time arrivals per stop |

Three things about this data shape the whole app:

**Timetables are hidden inside the response.** Each stop carries a `timings`
array, and `timings[].order` is a *trip number* shared across every stop on the
route. Grouping by it reconstructs a proper GTFS-style timetable — R1 trip 29 runs
stop 1 at 12:45 through stop 18 at 13:55.

**Routes are loops with explicit return stops.** A route's stop list runs the
outbound leg and then the return leg, with return stops given their own codes
suffixed `OPP`. So a ride is valid exactly when the boarding position precedes the
alighting position, and wrap-around at the terminal is not modelled.

**RTL only returns departures still to come.** Open the app in the evening and the
morning is simply missing. Each response is merged into a per-day store in
IndexedDB keyed by `(routeCode, tripOrder)`, so the picture fills in over the day
and offline planning keeps working. It's keyed by service date and never carried
across days, since schedules may differ.

**Four routes publish no timetable at all** — R10, R11, R12 and R15 are
frequency-based minibuses with empty `timings` everywhere. Their times are
synthesised from an assumed headway and always labelled *Estimated* in the UI. A
guess is never presented as a timetable.

### The planner

[`src/lib/transit/plan.ts`](src/lib/transit/plan.ts) is a round-based RAPTOR
search allowing up to two transfers. At this size — 15 routes, 101 stops, ~40
trips each — it settles in a couple of milliseconds.

Results are ranked by generalized cost rather than raw arrival time — distance,
time and money in one number, all expressed in minutes. Sorting on arrival alone
produces itineraries that shave four minutes off by making you walk an extra 600 m,
or that charge you a second MVR 10 fare to arrive three minutes sooner. So walking
is charged at roughly double its real duration (the standard "walk reluctance 2.0"),
each transfer costs 5 minutes, each rufiyaa of fare costs a minute, and estimated
times lose ties to published ones. Fares are per boarding, so a two-bus trip really
does cost MVR 20–25 against a direct MVR 10, which arrival time alone never sees.

Distance ridden on the bus is measured and shown but deliberately left out of the
ranking: the time it takes already pays for it, and charging for it twice would
recommend shortcuts that are slower, dearer, or both.

Walking is the one trade-off the planner can't guess — the same 600 m is a pleasant
shortcut at 7am and out of the question at noon carrying shopping — so **Less
walking / Balanced / Fastest** sits above the results and reweights them in place
(30, 12 and 3 min/km respectively). It only reorders; the walking distance cap still
decides what's walkable at all.

Only the best trip per *combination of routes* is shown, because four variations of
the same two buses is not a choice.

Live ETAs are layered on afterwards, never inside the search: coverage is partial
(some routes report no buses at all), so the schedule stays the source of truth and
a missing ETA can never cost you an itinerary.

Walking uses straight-line distance inflated by 1.35 at 1.35 m/s rather than a
routing API — deterministic, offline and free of rate limits. It's isolated in
[`src/lib/geo.ts`](src/lib/geo.ts) so it can be swapped later.

Note that Villimalé is reached by ferry, not by bus. R13 and R14 are internal to
it, and the app correctly finds no itinerary between it and Malé.

### The map

MapLibre GL with [OpenFreeMap](https://openfreemap.org) vector tiles — free, no
API key, no usage limits. Vector tiles also cost far less mobile data than raster.
MapLibre is code-split into its own chunk and lazy-loaded so the UI paints first.

## Mobile

Installable PWA with an offline app shell, cached basemap tiles and the merged
daily timetable. `100dvh` and safe-area insets throughout, 44 px minimum touch
targets, drag-snap bottom sheets, and live polling that pauses whenever the tab is
backgrounded. Saved places and recent trips live in `localStorage` and never
leave the device.

## Layout

```
src/
  api/            RTL endpoints, Photon geocoding
  lib/
    geo.ts        haversine, walking model, line simplification
    time.ts       clock parsing pinned to UTC+5 (Maldives has no DST)
    transit/      graph building, RAPTOR planner, live overlay, ETA parsing
  hooks/          data fetching, geolocation, search
  components/     UI and map layers
  screens/        home, results, trip detail, stop detail, saved places
```
