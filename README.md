# RTL Improved

A mobile-first trip planner for RTL's Greater Malé bus network. Tell it where
you're going and it works out which bus to take, where to walk, when to board and
when you'll arrive — with live bus positions and real-time arrivals.

RTL's own site maps the routes but has no journey planner, so this fills that gap.
Covers the 15 Greater Malé routes (Malé, Hulhulé/airport, Hulhumalé and Villimalé).

## Running it

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # production PWA into dist/
npm run test           # planner + parsing tests against a real API fixture
npm run smoke          # hit all four RTL endpoints for all 15 routes
npm run preview & npm run e2e   # drive the built app in a mobile viewport, online and offline
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

### Live buses

`livecoordinates` gives a position and nothing else — no heading, no speed, no
timestamp — so a bus dot on its own tells you a bus is *there*, not which way it
is going, which is the thing a rider actually needs to know. Direction is
therefore inferred in [`src/lib/transit/busTracks.ts`](src/lib/transit/busTracks.ts)
by remembering where each bus was on earlier polls.

The catch is that a parked bus still jitters a few metres every poll, and a
bearing taken off that jitter spins the arrow at random. So the heading is only
recomputed once a bus has travelled 12 m clear of an *anchor* — the position that
set the current heading — rather than clear of the previous poll. Small real
movements still accumulate against the anchor and eventually register, while
noise never does. The dot itself follows every reading, so it stays live while
the arrow stays steady. A heading is never guessed across a gap in reporting
longer than 90 seconds, or from a jump too fast to be a bus, and a stopped bus
keeps its last heading rather than snapping back to north.

Positions also land off the road. The tracker is a consumer GPS in a dense
low-rise city, so buses are regularly drawn a block from their own route —
through buildings, or in the lagoon beside the Hulhumale' link road. The route
geometry is known exactly, so
[`src/lib/transit/snapToRoute.ts`](src/lib/transit/snapToRoute.ts) pulls a
reported position back onto it — but only as far as the error deserves. Within
40 m the nearest point on the route is taken as the truth; the correction tapers
away to nothing by 120 m; past that the reading stands. A bus 200 m off its route
is not suffering GPS error — it is on a diversion, running out of service, or the
shape is incomplete — and moving it onto the line would invent a fact rather than
clean one up. The correction happens before the heading is inferred, so the arrow
steadies too.

Each bus drags a short trail behind it, fading out towards the oldest end so the
bright end reads as *now*. It is drawn from the positions the bus was confirmed
to have reached — the same ones the heading is inferred from — so a parked bus
leaves no smear of jitter, and a jump the feed cannot account for restarts the
trail rather than drawing a line across the island.

Tapping a bus shows what is actually known about it: plate and vehicle code,
inferred heading and speed, how long since it last moved, and how old the reading
is. All of it is labelled as estimated, because none of it is telemetry.

### Riding it

The planner's job ends where the rider's begins. **Start journey** turns the
chosen trip into one instruction at a time — walk to this stop, wait for this
bus, ride to that one, you have arrived — with the thing that completes the step
as a thumb-sized button pinned below the sheet, in the same place whatever it
says.

A bus leg becomes two steps, because standing at a stop watching for a bus that
has not come and sitting on it counting stops are different situations: they need
different instructions, a different button and a different map.

**Only walking completes itself.** Arriving at a stop on foot is unambiguous, so
the fix moves the journey on and the rider never has to tell the app what it can
see. Being beside a bus and being on it are the same coordinates, though, and a
bus passes the alighting stop whether or not anybody stands up — so *I've
boarded* and *I've got off* stay taps. An app that boarded you onto a bus you
watched pull away would be worse than one that waits to be told, and there is a
*back a step* under the button for the stop that went past while you were looking
at your phone.

**A tap outranks the fix.** Someone who presses *I've got off* is standing at
that stop, and that is a harder fact than anything a phone can infer: a handset
that last saw the sky in Malé will happily go on reporting Malé while its owner
steps off a bus in Hulhumalé. So the last stop the rider confirmed is the anchor,
and the reported position is preferred over it only while the two are telling the
same story — within 800 m of either the anchor or where this step ends, which is
wide enough that walking the length of a step never makes the rider disbelieved.
A ride is judged against the ride itself rather than its ends, since a rider
halfway along is far from both. It is why getting off at a transfer moves the map
onto the next route instead of snapping back to where the phone last had a fix.

How close counts as "there" follows the accuracy the browser reports rather than
a fixed radius, because a consumer GPS is good to twenty metres on the seafront
and much worse between the tower blocks — clamped at 120 m, since past that the
reading is not a bus stop, it is a neighbourhood. With no fix at all nothing is
claimed and every step is a tap, which is exactly the app with location refused.

While riding, the alighting stop is announced at 250 m — far enough out to stand
up, rather than as it goes past — with a buzz, since that is the moment a rider
most needs telling and is least likely to be looking at the screen. The rest of
the ride is listed stop by stop with the ones already passed faded, so the count
can be followed out of the window instead of trusted.

The map follows whatever the step is *about*. Walking and riding are about the
rider, so it keeps them centred; waiting and arriving are about a place, so it
centres the stop or the door. The two are framed together only while they are
close enough for that to show anything. This matters most at a transfer: the
rider gets off in Hulhumalé having last been fixed in Malé, and a box around both
would draw eight kilometres of link road instead of the stop they are standing
at. A deliberate pan hands the map back and offers a *recentre*; every new
instruction takes it again.

The screen is held awake for as long as the journey runs, because a rider walking
to a stop is not touching their phone and unlocking it one-handed at a junction
to find out where to go next is the whole problem.

### Links

The trip lives in the address bar — `?from=me&to=stop:T02&route=...` — so a
refresh comes back to the same screen and the link opens the same trip on someone
else's phone. A journey under way is carried there too, as `&step=ride-1&since=845`:
a phone that dies at the stop comes back to the instruction it was on and to the
clock it started, not to the top of the trip. `me` is the rider's own position rather than a fixed point, which
is also how the recents list knows that the same journey started three streets
apart on two different days is one journey and not two.

Places that a link cannot resolve on its own — a stop code before the timetable
has loaded, `me` before the browser has answered — are held until their
ingredients arrive, and written back to the URL meanwhile, so a reload during
those first seconds loses nothing. The address bar is replaced rather than pushed:
these are edits to one journey, not separate pages, and the back button should not
walk through a rider's typing.

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
    geo.ts        haversine, bearings, walking model, line simplification
    time.ts       clock parsing pinned to UTC+5 (Maldives has no DST)
    urlState.ts   the trip in the address bar
    transit/      graph building, RAPTOR planner, live overlay, ETA parsing,
                  bus heading inference, route snapping, place identity,
                  journey steps
  hooks/          data fetching, geolocation, search
  components/     UI and map layers
  screens/        home, results, trip detail, step-by-step journey, stop
                  detail, saved places
```
