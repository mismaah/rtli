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

### The backend

There is an optional Go service in [`server/`](server/). The app works without
it — that is the whole design constraint — but four things are structurally
impossible for a browser alone:

**The timetable is only as complete as one device observed.** RTL returns only
*upcoming* departures, so a fresh install at 19:00 has no morning and cannot
answer "what time is the first bus". The server watches all day and serves the
whole thing.

**Port 4455 is blocked on some networks.** The server sits on :443 and proxies.

**Every client polls independently.** A single phone on the trip screen can issue
~50 requests a minute. One server loop serves everyone — and only polls tightly
for routes somebody is actually watching, so idle load stays near 45 req/min for
the whole network rather than rising per user.

**No history exists.** The 15-minute headway assumed for R10, R11, R12 and R15 is
a guess. Recorded movement turns it into a measurement.

#### What the poll rate actually is

Measured against the live feed, not assumed: **each bus's position advances on a
~11 second cycle**, buses update independently and staggered, and the median
movement per update is 64 m. Polling faster than that returns the same
coordinates — the client's existing 10 s poll is already rate-matched to the
source.

So the server does not poll faster to get more data; there is none. It polls at
3 s to notice a change *sooner*, and pushes it over SSE. A 10 s poll sits at a
random phase against an 11 s cycle and is ~5.5 s stale on average, which at 64 m
per update is roughly 30 m of error. Streaming cuts that to ~1.5 s.

Smoothness comes from the client, not the network: markers glide between two
*known* fixes over 900 ms. That is catch-up interpolation, never extrapolation —
no position ahead of the data is invented, and the popup goes on reporting the
true age of the reading.

#### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v1/graph` | Routes, stops and timetables, in RTL's own shape |
| `GET /v1/shapes/{routeCode}` | Route geometry, pre-simplified (R2: 374 KB → 8.6 KB) |
| `GET /v1/etas?routes=…` | One request in place of a per-route fan-out |
| `GET /v1/live/stream?routes=…` | SSE: snapshot on connect, then per-bus deltas |
| `GET /v1/live/{routeCode}` | Plain-JSON positions, for clients that cannot stream |
| `GET /v1/meta`, `/healthz` | Freshness and liveness |

The graph is served in RTL's own JSON shape rather than as a prebuilt graph, so
[`buildGraph.ts`](src/lib/transit/buildGraph.ts) stays the single normalizer and
the server can never disagree with the direct-to-RTL fallback about what a route
is.

Because the server has been tracking continuously, the SSE snapshot arrives with
headings, speeds and trails already inferred. Polling cannot do that: the client
must watch a bus travel 12 m across two polls before it can draw an arrow, and it
discards that history on every route change.

#### The fallback ladder

Server → RTL directly → today's IndexedDB snapshot. The seam is inside
[`src/api/rtl.ts`](src/api/rtl.ts), where all four fetchers already funnel
through one request helper, so no call site knows the server exists. A circuit
breaker sets the server aside after two consecutive failures for 60 s — without
it, a server that is down would make every request pay a timeout before falling
back, which is a latency regression exactly when things are already wrong.

#### Storage

SQLite, no user data of any kind — no accounts, no cookies, nothing keyed to a
person or device. Saved places and recent trips stay in `localStorage` as before.

Two retention tiers, because raw positions are bulky and short-lived while what
is learned from them is small and worth keeping: **raw fixes are pruned at 7
days, derived aggregates at 90**. Only real movement is recorded — a parked bus
re-reporting the same coordinates every 11 seconds would be most of the table.

#### Running it

```bash
cd server
go test ./...
go run ./cmd/rtld -addr :8080 -db rtld.db
```

Then point the app at it and rebuild:

```bash
VITE_API_BASE=https://api.example.com npm run build
```

Unset, the app calls RTL directly exactly as before.

#### Deploying

The front end is on Cloudflare Pages; the backend runs in Docker on a home
server, reached only through a Cloudflare Tunnel. Set `VITE_API_BASE` in the
Pages build environment to the tunnel's hostname.

```bash
cp server/deploy.env.example server/deploy.env   # then edit ALLOW_ORIGIN
./docker.sh                                      # pull, build, restart, follow logs
./docker.sh --no-pull                            # rebuild the working tree as-is
```

The image is a statically linked binary on `distroless/static` — 21 MB, no
shell, no package manager. The container runs read-only, with all capabilities
dropped, and as the invoking user so the database stays inspectable without
root. The build happens before the running container is touched, so a broken
build leaves the current deployment up.

Before starting, the script proves the container can write to the mounted
directory by running `rtld -check` in a throwaway container. This is worth doing
from *inside* a container because the ways a bind mount refuses to be written to
are invisible from the host: a uid that does not line up, SELinux declining the
mount, or rootless Docker remapping the container's user to a subuid that owns
nothing. Ownership is fixed automatically; the other two are reported with what
to do about them. `RUN_AS` and `VOLUME_OPTS` override the defaults — under
rootless Docker, `RUN_AS=0:0` maps to the host user who owns the directory.

The container also runs with `-require-store`, so a database it cannot open is
a startup failure rather than a silent fallback. Run without that flag the
server degrades to a cache and keeps serving, which is right at runtime and
wrong for a deploy: it would report healthy while recording nothing.

Three things about this shape are load-bearing:

**The port is bound to loopback**, not published to the network. The tunnel
reaches it locally and nothing else can reach it at all.

**`-trust-proxy` is set, and is only safe because of that.** Behind the tunnel
every request arrives from `cloudflared` on loopback, so `RemoteAddr` is the same
address for every visitor alike and a per-client limit keyed on it would be
meaningless. Cloudflare supplies the real client in `CF-Connecting-IP`. On a
directly reachable port that flag would instead let anyone forge an identity per
request and walk straight past the limits. (If capacity refusals ever appear
under light load, check that header is actually arriving — without it every
visitor shares one identity and `MAX_PER_CLIENT` becomes a global cap.)

**Nothing may buffer `/v1/live/stream`.** It is sent with `X-Accel-Buffering: no`
and `Cache-Control: no-transform`, and the 20-second heartbeat keeps it inside
Cloudflare's idle timeout. Get this wrong and the stream connects and then
silently delivers nothing until it drops, which looks exactly like a broken feed.

#### Limits and staleness

The stream is public and unauthenticated, so connections are capped — 500 in
total and 20 per client by default. Cloudflare handles volumetric abuse; these
are the backstop that stops one host exhausting memory. The per-client figure is
deliberately loose: Malé's mobile carriers use CGNAT, so a great many real riders
share one source address and a tight cap would lock out a network rather than an
abuser. Refusals are a `503` with `Retry-After`, sent before any streaming header
so the client can actually read them.

Every cache also has a **stale bound**: how far past its TTL an entry may still
be served while upstream is unreachable, after which the request fails so the
client falls back to RTL or to its own saved snapshot. Serving something slightly
old beats a blank screen; serving it indefinitely means quietly presenting
yesterday as today.

| | TTL | Stale bound |
|---|---|---|
| Timetable | 60 s | 6 h — routes are static and the timetable covers the day |
| Geometry | 24 h | 7 d — stale geometry is simply correct geometry |
| ETAs | 10 s | 60 s — a countdown is only true near when it was read |
| Positions | 2 s | 30 s — a bus drawn where it was is a bus in the wrong place |

#### Overnight

Buses report roughly 04:00–01:00, so the poller sleeps from **01:00 to 03:59**
Malé time: no position requests, no ETA requests, nothing sent to RTL for three
hours. Retention still runs hourly, which is a good time for it, and the cached
endpoints still answer.

Two things follow from that gap, and both are handled rather than tolerated.

**Positions expire.** Nothing is polling, so without a bound the last fleet of
the night would sit in memory until morning and a client connecting at 02:00
would receive it as its opening snapshot — a live-looking picture of where buses
were three hours ago. Tracks older than five minutes are withheld and swept from
memory, so the honest answer at 3am is an empty snapshot. Five minutes is
comfortably longer than the 20-second idle poll, so an unwatched route's
perfectly good position is never thrown away for being one cycle old.

**Headings expire too.** A bus reappearing at 04:00 trips the 90-second gap guard,
so no heading is *inferred* across the silence — but the heading already on
screen used to be kept regardless, which meant a bus could briefly show last
night's direction. A heading now survives ten minutes of silence and no longer:
long enough that a momentary dropout keeps its arrow, short enough that a bus
which may have turned at a terminal, finished its run or been swapped out claims
nothing. A bus that is *present* but parked still keeps its heading indefinitely
— that is a different situation, and pointing the way it last went is correct.

#### Keeping the two in step

Bus heading, speed and trail inference exists twice: `busTracks.ts` /
`snapToRoute.ts` in TypeScript, and `server/internal/track` in Go. A client that
falls back from the server to RTL switches between them mid-session, so a
divergence would show up as a bus jumping on the map.

Both are held to one golden fixture built from real captured feed data —
[`test/fixtures/track-golden.json`](test/fixtures/track-golden.json), 120 frames
of four real buses. `test/trackGolden.test.ts` and
`server/internal/track/golden_test.go` assert against the same file, so either
side drifting is a build failure rather than a bug report. Regenerate
deliberately:

```bash
UPDATE_GOLDEN=1 npx vitest run test/trackGolden.test.ts
```

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

server/           optional Go backend (see "The backend")
  cmd/rtld/       entrypoint
  internal/
    rtl/          upstream client
    track/        Go port of the snapping and heading inference
    poller/       demand-led fan-in polling
    hub/          SSE broadcast
    store/        SQLite history and retention
    api/          HTTP handlers
```
