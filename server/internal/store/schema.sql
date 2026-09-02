-- rtl-improved backend store.
--
-- Two tiers, because raw positions are bulky and short-lived while what is
-- learned from them is small and worth keeping. Measured over a full day in
-- production: ~63k fixes at ~150 bytes, so ~9.5 MB/day — at the 20 s recording
-- floor that day ran on. The floor is now 10 s, so expect roughly double. Raw
-- data is pruned at store.RawRetention while the aggregates derived from it
-- survive 90 days.
--
-- Every day/hour column is Malé civil time (UTC+05:00, no DST), matching
-- serviceDate() in src/lib/time.ts. If these ever disagree the day buckets here
-- and the client's cache keys silently describe different days.

-- auto_vacuum must come first, and must come before anything writes a page.
-- SQLite can only change it while the database is still empty, and it fails
-- *silently* otherwise: setting journal_mode first allocates page 1, after
-- which this line is accepted and ignored, leaving auto_vacuum at NONE and the
-- incremental_vacuum in Prune a no-op. That is exactly what happened to the
-- first deployed database. ensureAutoVacuum in store.go repairs one already in
-- that state; this ordering stops a fresh one getting there.
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- One observed bus position. Only rows where the bus actually moved are kept:
-- a parked bus re-reporting the same coordinates teaches nothing and would be
-- most of the table.
CREATE TABLE IF NOT EXISTS bus_fix (
  id         INTEGER PRIMARY KEY,
  route_code TEXT    NOT NULL,
  bus_code   TEXT    NOT NULL,
  at_ms      INTEGER NOT NULL,
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  -- Position after correction onto the route geometry, and how far it moved.
  -- lat/lng above are the reading exactly as RTL gave it, kept alongside so a
  -- bad snap can always be reviewed against what it was correcting.
  snap_lat   REAL,
  snap_lng   REAL,
  offset_m   REAL,
  heading    REAL,
  speed_mps  REAL
);
CREATE INDEX IF NOT EXISTS bus_fix_route_at ON bus_fix (route_code, at_ms);
CREATE INDEX IF NOT EXISTS bus_fix_bus_at   ON bus_fix (bus_code, at_ms);
CREATE INDEX IF NOT EXISTS bus_fix_at       ON bus_fix (at_ms);

-- A bus observed arriving at a stop, and how that compared to the timetable.
-- delta_min is signed: positive is late.
CREATE TABLE IF NOT EXISTS stop_arrival (
  id         INTEGER PRIMARY KEY,
  route_code TEXT    NOT NULL,
  stop_code  TEXT    NOT NULL,
  bus_code   TEXT    NOT NULL,
  at_ms      INTEGER NOT NULL,
  trip_order INTEGER,
  sched_min  REAL,
  delta_min  REAL,
  dow        INTEGER NOT NULL, -- 0=Sunday
  hour       INTEGER NOT NULL,
  UNIQUE (route_code, stop_code, bus_code, at_ms)
);
CREATE INDEX IF NOT EXISTS stop_arrival_bucket ON stop_arrival (route_code, stop_code, dow, hour);
CREATE INDEX IF NOT EXISTS stop_arrival_at     ON stop_arrival (at_ms);

-- Observed time to ride between two consecutive stops.
CREATE TABLE IF NOT EXISTS segment_obs (
  id         INTEGER PRIMARY KEY,
  route_code TEXT    NOT NULL,
  from_stop  TEXT    NOT NULL,
  to_stop    TEXT    NOT NULL,
  at_ms      INTEGER NOT NULL,
  secs       REAL    NOT NULL,
  dow        INTEGER NOT NULL,
  hour       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segment_obs_bucket ON segment_obs (route_code, from_stop, to_stop, dow, hour);
CREATE INDEX IF NOT EXISTS segment_obs_at     ON segment_obs (at_ms);

-- Gap between successive buses at a stop. This is what finally replaces the
-- assumed 15-minute headway for R10, R11, R12 and R15, which publish no
-- timetable at all.
CREATE TABLE IF NOT EXISTS headway_obs (
  id         INTEGER PRIMARY KEY,
  route_code TEXT    NOT NULL,
  stop_code  TEXT    NOT NULL,
  at_ms      INTEGER NOT NULL,
  secs       REAL    NOT NULL,
  dow        INTEGER NOT NULL,
  hour       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS headway_obs_bucket ON headway_obs (route_code, stop_code, dow, hour);
CREATE INDEX IF NOT EXISTS headway_obs_at     ON headway_obs (at_ms);

-- The merged full-day timetable per service date. This is what lets a phone
-- opening the app at 19:00 see the whole day instead of only what remains of it.
CREATE TABLE IF NOT EXISTS day_timetable (
  service_date TEXT    PRIMARY KEY, -- YYYY-MM-DD, Malé civil date
  updated_ms   INTEGER NOT NULL,
  payload      BLOB    NOT NULL     -- RouteDetailsResponse JSON, gzip'd
);

-- Which routes reported any movement on a given day, so a route that simply is
-- not running can be told apart from one the planner merely did not choose.
CREATE TABLE IF NOT EXISTS route_activity (
  service_date TEXT    NOT NULL,
  route_code   TEXT    NOT NULL,
  first_ms     INTEGER NOT NULL,
  last_ms      INTEGER NOT NULL,
  fix_count    INTEGER NOT NULL,
  PRIMARY KEY (service_date, route_code)
);
