# Backend handoff

Context for picking this work up in a fresh session. The Go backend in
[`server/`](server/) was designed, built and deployed on 2026-09-01/02. Read
[README.md](README.md) for *how it works*; this file covers **state, decisions,
and traps** — the things a new session would otherwise re-derive or get wrong.

---

## Current state

**Deployed and verified in production.** Frontend on Cloudflare Pages at
`https://rtli.mismaah.com`, backend in Docker on the home server at
`/home/mismaah/apps/rtli`, exposed as `https://rtli-api.mismaah.com` via a
Cloudflare Tunnel.

What is *deployed* is all committed to `main` and pushed (`af46312`, `0b85346`,
`c2148c8`). The tree is no longer clean — see *Uncommitted* below.
A stale `feat/go-backend` branch still exists locally and can be deleted.

Verified live on 2026-09-02, not merely assumed:

- SSE streams **unbuffered** through Cloudflare — frames arrived at 0.00s
  (snapshot), 13.57s / 13.61s (etas), 19.73s (ping). Buffering would deliver
  them in one clump at the end.
- A real browser on the live site made **7 backend requests + 1 SSE stream and
  zero direct calls to RTL**, with no console or page errors.
- CORS echoes `https://rtli.mismaah.com`, correctly absent for other origins.
- Buses reporting and history recording.

**Shipped:** read-through cache, SQLite recorder with tiered retention, SSE live
push with server-side snapping and heading inference, client fallback ladder.

**Not built:** server-side full-day timetable accumulation, and historical ETA
correction. See *Remaining work* below.

### Uncommitted, not yet deployed (2026-09-02 afternoon)

The first day's database was pulled off the server after ~14 hours and read.
That review produced four fixes, which are **in the working tree and green but
not committed and not on the server**:

1. `RawRetention` 7 days → **60 days**. Stopgap; see *Remaining work*.
2. A coordinate plausibility gate in **both** track implementations.
3. Raw coordinates actually persisted, rather than the snap twice.
4. `auto_vacuum` repaired on open, and the pragma ordering that broke it fixed.

Deploy 4 sooner rather than later: it does a one-time `VACUUM`, which took 307 ms
on the 5 MB file and gets slower as 60-day retention grows it.

---

## Measured facts — do not re-derive, do not "optimise" past these

These were measured against the live API, not assumed. Several are
counter-intuitive and a fresh session is likely to get them wrong.

| Fact | Value | Why it matters |
|---|---|---|
| Per-bus GPS cadence | **~11 s** (median 11.0, tight mode) | **Polling faster returns the same coordinates.** The client's old 10 s poll was already rate-matched. Do not "speed up" polling to get more data — there is none. |
| Update phasing | Staggered per bus, never synchronised | Why SSE sends per-bus deltas rather than fleet snapshots. |
| Median movement per update | **64 m** | A 10 s poll at random phase is ~5.5 s stale ≈ 30 m of error. That latency, not the data rate, is what streaming fixes. |
| ETA change rate | ~once per **30 s** | 10 s cache TTL and 15 s poll lose nothing. |
| Fleet | ~37 buses, 15 routes, 101 stops | The whole problem is small. Over a full day it is **43 distinct buses across 14 routes** — 14 of those buses serve more than one route, so bus→route is not stable and arrival matching must not assume it. The 15th route ran no buses at all that day, which is what `route_activity` exists to record. |
| Upstream RTT | ~190 ms | Fan-in polling is cheap. |
| Tolerated rate | 3 req/s sustained, no failures | Fan-in is within what upstream already serves. |
| Recorded fixes | **~63k/day at ~150 B** ≈ 9.5 MB/day | Measured over the first full day, not estimated. The schema's old "242k/day at 72 bytes, ~17 MB/day" guess was wrong in both directions. |
| **Stored** cadence | **15–30 s** for 29,015 of 37,260 gaps | Not the 11 s upstream offers. Nobody was watching, so every route sat on `IdleInterval`. The archive is under-sampled ~2x, and *more so the less popular the route*. See *Remaining work*. |
| Snap quality | offset p50 **2.5 m**, p90 7.7 m, p99 27 m | 133 rows of 37,303 over 100 m. The 40/120 m taper is well chosen; leave it alone. |
| Uptime, first day | No fleet-wide silence >90 s in service hours | The three gaps >90 s are all 04:25–04:55, when only ~5 buses were reporting. |
| Service hours | Buses report ~04:00–01:00 Malé | Zero buses observed at 00:01, buses again at 00:35 — service **does** run past midnight, so the window stays open to 01:00. |

**Smoothness comes from client-side interpolation, not more requests.** Markers
glide 900 ms between two *known* fixes — catch-up, never extrapolation.

---

## The one invariant that must not break

Bus heading/speed/trail inference exists **twice**: `src/lib/transit/busTracks.ts`
+ `snapToRoute.ts` in TypeScript, and `server/internal/track/` in Go. A client
falling back from the server to RTL switches implementations mid-session, so a
divergence shows up as a bus jumping on the map.

As of the 2026-09-02 review that pair also includes the plausibility gate:
`isPlausibleFix` in `busTracks.ts` and `IsPlausibleFix` in `track/tracks.go`,
each with mirrored unit tests. Widening the bounds on one side only would let a
bus exist on the server and vanish on the client.

Both are pinned to one golden fixture built from real captured feed data:

- `test/fixtures/track-sequence.json` — 120 polls, 4 real buses, 1 Hz
- `test/fixtures/track-golden.json` — expected output
- Asserted by `test/trackGolden.test.ts` **and** `server/internal/track/golden_test.go`

**Any change to inference must be made in both languages.** Regenerate only
deliberately — a diff here is a behaviour change:

```bash
UPDATE_GOLDEN=1 npx vitest run test/trackGolden.test.ts
```

Caveat: the fixture is 120 s of continuous reporting, so it does not exercise
long gaps. Edge cases (heading expiry, jitter hold, impossible jumps) are covered
by mirrored unit tests in `test/transit.test.ts` and
`server/internal/track/tracks_test.go` — keep those in step by hand.

---

## Architecture in one screen

```
server/
  cmd/rtld/         entrypoint, flags, graceful shutdown
  internal/
    rtl/            upstream client; types mirror src/api/rtl.ts exactly
    track/          Go port of snapToRoute + busTracks (pure, golden-tested)
    geo/            haversine, bearing, Douglas–Peucker (ports of src/lib/geo.ts)
    poller/         demand-led fan-in polling, snap → infer → publish → record
    hub/            SSE broadcast, route subscriptions, connection caps
    store/          SQLite, tiered retention
    cache/          single-flight TTL memo with a stale bound
    api/            handlers, CORS allowlist, real-IP resolution
```

**Endpoints:** `/v1/graph`, `/v1/shapes/{routeCode}`, `/v1/etas?routes=`,
`/v1/live/stream?routes=` (SSE), `/v1/live/{routeCode}`, `/v1/meta`, `/healthz`.

**Two design rules that constrain future changes:**

1. **The server serves RTL's own JSON shape, never a prebuilt graph.**
   `buildGraph.ts` stays the single normalizer, so the server and the
   direct-to-RTL fallback cannot disagree about what a route is.
2. **The server is optional.** Ladder is server → RTL direct → IndexedDB
   snapshot. Offline planning works today and must not regress. The seam is
   `src/api/rtl.ts` (all four fetchers funnel through one helper) plus a circuit
   breaker in `src/api/backend.ts`.

**Adaptive polling:** watched routes 3 s, unwatched 20 s, nothing 01:00–03:59.
Idle load ~45 req/min for the whole network. A naive "all routes every 3 s" would
be 300 req/min and worse than the status quo below ~7 concurrent users.

---

## Deployment

```bash
./docker.sh              # pull, build, replace container, health-check, follow logs
./docker.sh --no-pull    # rebuild the working tree as-is
```

Config in `server/deploy.env` (gitignored; example committed). Current values:
`PORT=4020`, `BIND_ADDR=127.0.0.1`, `DATA_DIR=data`,
`ALLOW_ORIGIN=https://rtli.pages.dev,https://rtli.mismaah.com`.

Three load-bearing details:

- **Port bound to loopback.** The tunnel reaches it locally; nothing else can.
- **`-trust-proxy` is only safe because of that.** Behind the tunnel every request
  arrives from `cloudflared` on loopback, so `RemoteAddr` is identical for every
  visitor; `CF-Connecting-IP` carries the real client. On a directly reachable
  port that flag would let anyone forge an identity and bypass connection caps.
- **Nothing may buffer `/v1/live/stream`.** Sent with `X-Accel-Buffering: no` and
  `Cache-Control: no-transform`; the 20 s heartbeat stays inside Cloudflare's
  idle timeout.

The container runs `-require-store`, so a database it cannot open is a startup
failure rather than a silent degrade to cache-only.

---

## Traps that already cost time

Each of these was hit for real. Do not rediscover them.

**Route `code` is a numeric id (`133` = R1); `R1` is `routeNumber`.** The live
endpoints want `code`. ETA rows return `routeNumber: null`. The first probe of
the session returned empty because of this.

**Docker Desktop on macOS masks bind-mount permission bugs.** It remaps ownership,
so a container running as *any* uid can write to a host directory. The original
`--user $(id -u):$(id -g)` approach passed every local test and then failed on the
Linux server with `SQLITE_CANTOPEN`. `docker.sh` now runs `rtld -check` in a
throwaway container as a preflight, because the failure modes (uid mismatch,
SELinux, rootless subuid remapping) are invisible from the host. **Local Docker
testing on macOS proves nothing about volume permissions.**

**Docker reads a bare relative `--volume` path as a named volume**, not a
directory. `DATA_DIR=data` silently created a Docker-managed volume while leaving
an empty `data/` in the repo. `docker.sh` now resolves relative paths against the
repo root.

**Cloudflare bot protection blocks non-browser user agents.** A `Python-urllib`
UA gets `403` on *every* path including `/healthz`; default `curl` gets `200`.
This is not an endpoint bug. It will block scripted uptime monitoring — needs a
WAF skip rule on the API hostname if that is wanted.

**`PRAGMA auto_vacuum` fails silently unless it is the first statement.** SQLite
can only change it while the database has no pages, and it *accepts and ignores*
the pragma otherwise — no error, no warning. `schema.sql` had `journal_mode = WAL`
first, which allocates page 1, so the deployed database ran with
`auto_vacuum = NONE` and the `PRAGMA incremental_vacuum` in `Prune` was a no-op
for its whole life. Reproduced exactly:

```
PRAGMA journal_mode=WAL; PRAGMA auto_vacuum=INCREMENTAL;  -> auto_vacuum=0
PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;  -> auto_vacuum=2
```

Ordering is fixed, and `ensureAutoVacuum` in `store.go` repairs an existing file
with a one-time `VACUUM` (the pragma alone cannot; only a full rewrite takes).
**Any new pragma that must stick goes above `journal_mode`.**

**RTL's feed emits `(0, 0)`.** It happened once on 2026-09-02 (bus `C1226`,
11:54:12) and was published to clients unchallenged: a bus in the Gulf of Guinea
for a frame, and an `offset_m` of 8,195,492 in the recorder. Snapping cannot help
— past `NO_SNAP_M` the reading is deliberately left alone, and there is no
position here to correct. The gate rejects it instead. Note that the *bounds*
alone do not catch it: the Maldives straddles the equator, so latitude 0 is
genuinely in-country and `(0, 73.5)` would pass. An exact `0.000000` on either
axis is rejected on its own terms, as an unset field rather than a fix.

**`npx prettier` rewrites the repo's single quotes to double.** There is no
committed prettier config, so it uses defaults that disagree with the codebase.
It mangled `vite.config.ts` into a 237-line diff; the fix was reverting and
hand-editing to a 44-line one. Do not run prettier on existing files.

**`npm run e2e` journey-navigation is flaky in the evening, on `main`,
independent of the backend.** Confirmed by stashing all changes and running clean
`main` at the same hour — it failed identically. Passes at ~17:50, fails from
~18:30 with two different failure modes (`h2` timeout at ~30 checks; "getting off
puts the rider at that stop… 1.1 km away" at 37). **Pre-existing and unfixed.**
Do not attribute it to backend changes without re-establishing a baseline.

---

## Remaining work

**Milestone 4.5 — the rollup. Nothing writes the aggregate tables.** This is the
one to do first, and it is not what the original plan assumed.

`stop_arrival`, `segment_obs` and `headway_obs` exist as schema, are pruned by
`retention.go`, and are counted by `Stats` — and **no code inserts into any of
them**. `store.go` exports only `InsertFixes`, `RecordActivity` and the three
timetable methods. After 14 hours of production the first day's counts were:

```
bus_fix        37,303      route_activity  14
stop_arrival        0      day_timetable    0
segment_obs         0      headway_obs      0
```

`Prune` carries the comment *"rollups must already have run, because once a fix
is deleted what it could have taught is gone"* — and no rollup exists. With the
original `RawRetention = 7 days`, every day's fixes were being deleted a week
later, so Milestone 5's "weeks of recorded history" would have restarted at zero
every week, forever.

`RawRetention` is now **60 days** as a stopgap — enough runway to write the
rollup and backfill from fixes that still exist. **Put it back to 7 once the
rollup runs and has backfilled**; 60 days is ~570 MB against ~66 MB.

**Milestone 4 — server-side full-day timetable.** The `day_timetable` table,
`PutTimetable`/`GetTimetable`/`DeleteTimetable` and their tests all exist; the
poller does not populate it and `/v1/graph` does not serve from it. This is the
strongest *user-facing* win left: RTL only returns upcoming departures, so a
fresh install at 19:00 has no morning and cannot answer "what time is the first
bus". A server watching all day fixes that for everyone.

It is also a **hard prerequisite for Milestone 5**, not a parallel track:
`stop_arrival.sched_min` and `delta_min` are schedule-adherence figures and there
is no schedule to compare against until this lands.

**Milestone 5 — historical ETA correction.** Needs weeks of recorded history,
which is why the recorder shipped first. Planned approach: **median** delta
bucketed by (route, stop, day-type, hour), **minimum 8 samples** before it is
trusted at all, then fall back to a coarser bucket, then to no correction. Never
extrapolate from one or two observations. Also replaces
`DEFAULT_HEADWAY_MIN = 15` for R10/R11/R12/R15 with measured headways — still
labelled *Estimated* either way.

Three things the first day's data says about how this can actually be built:

- **Predicted ETA is stored nowhere.** `pollEtas` publishes and discards. So
  *schedule adherence* is recoverable retroactively from fixes + timetable, but
  *ETA prediction error* is not recoverable at all — an `eta_obs` table has to
  start collecting before it becomes answerable. Decide which of the two the
  correction is actually correcting.
- **`pollEtas` only fetches routes with SSE subscribers**, so any ETA history
  would be collected only while someone happens to be watching.
- **The dwell at a stop is what `record` throws away.** Fixes are only written
  when `MovedAt` changes, so a bus waiting at a stop — the arrival signal — is
  suppressed by design. Arrival times are still inferable from the *gap* between
  the last fix before the dwell and the first after it, but that gap does not
  distinguish a dwell from a poller outage or an unwatched stretch.

**Open question — recording resolution.** Upstream publishes each bus every
~11 s, but recorded gaps cluster at 15–30 s because unwatched routes sit on
`IdleInterval = 20s`. Demand-led polling is right for *serving clients* and wrong
for *building a corpus*: it makes archive quality a function of who happened to
be looking. If the history matters, recording needs its own floor (~10 s)
decoupled from `hub.RouteSubscribers()`. That is a real change to the adaptive
polling design — read the load arithmetic in *Architecture* before touching it.

**Smaller:** the coordinate bounds in the plausibility gate are national
(−1…8 N, 72…74.5 E), deliberately far wider than observed operations
(4.169–4.234 N, 73.483–73.550 E). They are a garbage filter, not a service-area
check — do not tighten them to "fit the data", or a genuine route extension
disappears silently. Also, `@tanstack/query-sync-storage-persister` and
`react-query-persist-client` are in `package.json` but unused — dead deps. And
`buildTrips` in `buildGraph.ts` indexes by raw array position while `stops` is
sorted, so a stop dropped by the coordinate filter would shift trip times; latent,
pre-existing, and the server's future arrival-matching must not inherit it.

---

## Verifying

```bash
cd server && go test ./...     # 83 tests, includes the golden cross-language check
npm run test                   # 134 tests
npm run build && npm run preview & npm run e2e   # see the flakiness note above
```

Live checks (use `curl`, not Python — see the bot-protection trap):

```bash
curl -s https://rtli-api.mismaah.com/v1/meta
curl -sN 'https://rtli-api.mismaah.com/v1/live/stream?routes=133' | head -5
sqlite3 data/rtld.db "SELECT COUNT(*) FROM bus_fix;"          # on the server
sqlite3 data/rtld.db "SELECT route_code, fix_count FROM route_activity;"

# Must read 2 (INCREMENTAL). A 0 means the pragma was silently dropped again.
sqlite3 data/rtld.db "PRAGMA auto_vacuum;"

# Once the raw-coordinate fix is deployed this must be non-zero: nearly every
# reading gets corrected by a metre or two. A 0 means the snap is overwriting
# the reading in place again, as it did on day one.
sqlite3 data/rtld.db "SELECT COUNT(*) FROM bus_fix WHERE lat != snap_lat;"
```

An empty snapshot between 01:00 and 04:00 Malé is correct, not a fault — the
poller sleeps and positions older than 5 minutes are withheld and swept.
