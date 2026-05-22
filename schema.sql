-- schema.sql
-- Run this once in Railway's Postgres console to create all tables.
-- Railway → your project → Postgres plugin → Data tab → paste and run.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  device_id       TEXT NOT NULL UNIQUE,
  points_balance  INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catches (
  id              SERIAL PRIMARY KEY,
  user_id         INT  NOT NULL REFERENCES users(id),
  species         TEXT NOT NULL,
  length_in       NUMERIC(5,1),
  released        BOOLEAN DEFAULT TRUE,
  bait            TEXT,
  note            TEXT,
  lat             NUMERIC(10,6),
  lon             NUMERIC(10,6),
  tide_height_ft  NUMERIC(5,2),
  tide_direction  TEXT,
  wind_kts        INT,
  wind_direction  TEXT,
  baro_in_hg      NUMERIC(6,2),
  moon_pct        INT,
  good_bite_score INT,
  pts_awarded     INT DEFAULT 0,
  caught_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON catches (user_id, caught_at DESC);
CREATE INDEX ON catches (user_id, DATE(caught_at));

CREATE TABLE IF NOT EXISTS points_transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INT  NOT NULL REFERENCES users(id),
  delta        INT  NOT NULL,
  reason       TEXT NOT NULL,
  reference_id TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON points_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS points_holds (
  id                  SERIAL PRIMARY KEY,
  user_id             INT  NOT NULL REFERENCES users(id),
  points_held         INT  NOT NULL,
  shopify_product_id  TEXT NOT NULL,
  product_title       TEXT,
  discount_code       TEXT NOT NULL UNIQUE,
  discount_code_id    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  shopify_order_id    TEXT,
  confirmed_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON points_holds (user_id, status);
CREATE INDEX ON points_holds (discount_code);
CREATE INDEX ON points_holds (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS milestones (
  id         SERIAL PRIMARY KEY,
  user_id    INT  NOT NULL REFERENCES users(id),
  key        TEXT NOT NULL,
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS spots (
  id          SERIAL PRIMARY KEY,
  user_id     INT  NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'flat',
  lat         NUMERIC(10,6) NOT NULL,
  lon         NUMERIC(10,6) NOT NULL,
  note        TEXT,
  is_private  BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON spots (user_id);
