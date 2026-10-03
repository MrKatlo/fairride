-- 0001_init.sql
-- FairRide initial schema (Cloudflare D1 / SQLite).
--
-- Conventions used throughout:
--   * ids are application-generated TEXT (ULID/UUID). Disclose them freely.
--   * booleans are INTEGER 0/1 (SQLite has no bool).
--   * timestamps are TEXT in ISO-8601 UTC with milliseconds, e.g.
--     2026-10-03T06:31:00.000Z. This is what `z.iso.datetime()` accepts, so
--     rows map to the shared domain types with zero massaging.
--   * money is REAL in the ride's `currency`. Migrate to INTEGER minor units
--     (cents) before you handle meaningful volume - see README "Known gaps".

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  phone             TEXT NOT NULL UNIQUE,
  email             TEXT,
  role              TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'admin')),
  full_name         TEXT,
  profile_photo_url TEXT,
  rating            REAL NOT NULL DEFAULT 5.0,
  total_rides       INTEGER NOT NULL DEFAULT 0,
  is_blocked        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One-time passwords for phone login. Never store the code in plaintext.
CREATE TABLE otp_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_otp_phone ON otp_codes (phone, expires_at);

CREATE TABLE drivers (
  user_id              TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  vehicle_make         TEXT,
  vehicle_model        TEXT,
  vehicle_year         INTEGER,
  vehicle_color        TEXT,
  vehicle_plate        TEXT,
  vehicle_photo_url    TEXT,
  license_number       TEXT,
  license_photo_url    TEXT,
  insurance_photo_url  TEXT,
  approval_status      TEXT NOT NULL DEFAULT 'pending'
                         CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  is_online            INTEGER NOT NULL DEFAULT 0,
  current_lat          REAL,
  current_lng          REAL,
  last_location_update TEXT,
  total_earnings       REAL NOT NULL DEFAULT 0,
  commission_rate      REAL NOT NULL DEFAULT 0.20 CHECK (commission_rate BETWEEN 0 AND 1)
);

-- Live driver search reads this. Until you move presence into a Durable
-- Object, keep the bounding box on is_online first and refine with Haversine.
CREATE INDEX idx_drivers_online ON drivers (is_online, current_lat, current_lng);

CREATE TABLE rides (
  id                      TEXT PRIMARY KEY,
  passenger_id            TEXT NOT NULL REFERENCES users (id),
  driver_id               TEXT REFERENCES users (id),
  status                  TEXT NOT NULL
                            CHECK (status IN ('requested','negotiating','accepted',
                                              'arrived','started','completed','cancelled')),
  pickup_lat              REAL NOT NULL,
  pickup_lng              REAL NOT NULL,
  pickup_address          TEXT,
  dropoff_lat             REAL NOT NULL,
  dropoff_lng             REAL NOT NULL,
  dropoff_address         TEXT,
  passenger_proposed_price REAL,
  final_price             REAL,
  currency                TEXT NOT NULL DEFAULT 'USD',
  distance_meters         INTEGER,
  duration_seconds        INTEGER,
  -- Bumped on every write so a stale REST client cannot clobber a newer state.
  version                 INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  accepted_at             TEXT,
  arrived_at              TEXT,
  started_at              TEXT,
  completed_at            TEXT,
  cancelled_at            TEXT,
  cancelled_by            TEXT,
  cancellation_reason     TEXT
);
CREATE INDEX idx_rides_status_created ON rides (status, created_at DESC);
CREATE INDEX idx_rides_passenger ON rides (passenger_id, created_at DESC);
CREATE INDEX idx_rides_driver ON rides (driver_id, created_at DESC);

CREATE TABLE ride_offers (
  id           TEXT PRIMARY KEY,
  ride_id      TEXT NOT NULL REFERENCES rides (id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users (id),
  from_role    TEXT NOT NULL CHECK (from_role IN ('passenger', 'driver', 'admin', 'system')),
  price        REAL NOT NULL CHECK (price > 0),
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at  TEXT
);
CREATE INDEX idx_offers_ride ON ride_offers (ride_id, created_at ASC);

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  ride_id    TEXT NOT NULL REFERENCES rides (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id),
  role       TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'admin', 'system')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_chat_ride ON chat_messages (ride_id, created_at ASC);

-- Append-only audit log. Every status change and offer resolution lands here.
CREATE TABLE ride_events (
  id         TEXT PRIMARY KEY,
  ride_id    TEXT NOT NULL REFERENCES rides (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_events_ride ON ride_events (ride_id, created_at ASC);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  ride_id             TEXT NOT NULL REFERENCES rides (id),
  amount              REAL NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  provider            TEXT NOT NULL,
  provider_payment_id TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- One payment row per ride; makes webhook retries idempotent.
CREATE UNIQUE INDEX idx_payments_ride ON payments (ride_id);
CREATE UNIQUE INDEX idx_payments_provider ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE TABLE ratings (
  id           TEXT PRIMARY KEY,
  ride_id      TEXT NOT NULL REFERENCES rides (id),
  from_user_id TEXT NOT NULL REFERENCES users (id),
  to_user_id   TEXT NOT NULL REFERENCES users (id),
  score        INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Each side may rate the other exactly once per ride.
CREATE UNIQUE INDEX idx_ratings_unique ON ratings (ride_id, from_user_id);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  title      TEXT,
  body       TEXT,
  data       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
