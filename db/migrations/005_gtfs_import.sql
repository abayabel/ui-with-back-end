CREATE TABLE IF NOT EXISTS gtfs_feeds (
  feed_id text PRIMARY KEY,
  source_name text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  feed_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_inventory jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtfs_source_records (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  file_name text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  source_record_id text,
  record_data jsonb NOT NULL,
  record_sha256 char(64) NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (feed_id, file_name, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_source_records_id_idx
  ON gtfs_source_records (feed_id, file_name, source_record_id);

CREATE TABLE IF NOT EXISTS gtfs_routes (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  source_route_id text NOT NULL,
  agency_id text,
  short_name text,
  long_name text,
  route_type integer,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_routes_source_id_idx
  ON gtfs_routes (feed_id, source_route_id);

CREATE TABLE IF NOT EXISTS gtfs_stops (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  source_stop_id text NOT NULL,
  stop_name text,
  latitude double precision,
  longitude double precision,
  location_type integer,
  parent_station text,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_stops_source_id_idx
  ON gtfs_stops (feed_id, source_stop_id);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  source_trip_id text NOT NULL,
  source_route_id text NOT NULL,
  service_id text NOT NULL,
  headsign text,
  short_name text,
  direction_id smallint,
  shape_id text,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_trips_source_id_idx
  ON gtfs_trips (feed_id, source_trip_id);
CREATE INDEX IF NOT EXISTS gtfs_trips_route_service_idx
  ON gtfs_trips (feed_id, source_route_id, service_id);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  source_trip_id text NOT NULL,
  arrival_time text,
  departure_time text,
  source_stop_id text NOT NULL,
  stop_sequence integer NOT NULL,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_stop_times_trip_sequence_idx
  ON gtfs_stop_times (feed_id, source_trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS gtfs_stop_times_stop_id_idx
  ON gtfs_stop_times (feed_id, source_stop_id);

CREATE TABLE IF NOT EXISTS gtfs_service_calendars (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  service_id text NOT NULL,
  monday boolean,
  tuesday boolean,
  wednesday boolean,
  thursday boolean,
  friday boolean,
  saturday boolean,
  sunday boolean,
  start_date date,
  end_date date,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_service_calendars_service_idx
  ON gtfs_service_calendars (feed_id, service_id);

CREATE TABLE IF NOT EXISTS gtfs_service_exceptions (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  service_id text NOT NULL,
  service_date date NOT NULL,
  exception_type smallint NOT NULL,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_service_exceptions_date_idx
  ON gtfs_service_exceptions (feed_id, service_id, service_date);

CREATE TABLE IF NOT EXISTS gtfs_frequencies (
  feed_id text NOT NULL REFERENCES gtfs_feeds(feed_id) ON DELETE CASCADE,
  source_row integer NOT NULL,
  source_trip_id text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  headway_seconds integer NOT NULL,
  exact_times smallint,
  source_data jsonb NOT NULL,
  PRIMARY KEY (feed_id, source_row)
);

CREATE INDEX IF NOT EXISTS gtfs_frequencies_trip_idx
  ON gtfs_frequencies (feed_id, source_trip_id);
