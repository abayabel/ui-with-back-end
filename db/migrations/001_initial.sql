CREATE TABLE routes (
  id text PRIMARY KEY,
  origin text NOT NULL,
  destination text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  fare numeric(12, 2) NOT NULL CHECK (fare > 0),
  trips jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  id text PRIMARY KEY,
  route_id text NOT NULL REFERENCES routes(id),
  trip_id text NOT NULL,
  travel_date date NOT NULL,
  departure_time text NOT NULL,
  arrival_time text NOT NULL,
  seat text NOT NULL,
  passenger_name text NOT NULL CHECK (char_length(passenger_name) BETWEEN 1 AND 60),
  amount_paid numeric(12, 2) NOT NULL CHECK (amount_paid > 0),
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'used')),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'valid' AND used_at IS NULL) OR (status = 'used' AND used_at IS NOT NULL))
);

CREATE INDEX tickets_created_at_idx ON tickets (created_at DESC);

CREATE TABLE monthly_subscriptions (
  id text PRIMARY KEY,
  route_id text NOT NULL REFERENCES routes(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7),
  round_trip boolean NOT NULL DEFAULT false,
  amount_paid numeric(12, 2) NOT NULL CHECK (amount_paid > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX monthly_subscriptions_created_at_idx ON monthly_subscriptions (created_at DESC);
