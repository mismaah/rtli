-- rtl-improved backend store.
--
-- Two tiers, because raw positions are bulky and short-lived while what is
-- learned from them is small and worth keeping. Roughly 242k fixes a day at ~72
-- bytes is ~17 MB/day, so raw data is pruned at 7 days (~122 MB steady state)
-- while the aggregates derived from it survive 90.
--
-- Every day/hour column is Malé civil time (UTC+05:00, no DST), matching
-- serviceDate() in src/lib/time.ts. If these ever disagree the day buckets here
-- and the client's cache keys silently describe different days.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA auto_vacuum = INCREMENTAL;

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
  -- Kept alongside the raw reading so a bad snap can always be reviewed.
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
