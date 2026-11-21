CREATE TABLE stops (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

INSERT INTO stops (id, name)
SELECT lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')), name
FROM (
  SELECT origin AS name FROM routes
  UNION
  SELECT destination AS name FROM routes
) route_endpoints
ON CONFLICT (id) DO NOTHING;

ALTER TABLE routes
  ADD COLUMN origin_stop_id text REFERENCES stops(id),
  ADD COLUMN destination_stop_id text REFERENCES stops(id);

UPDATE routes r SET origin_stop_id = s.id
FROM stops s WHERE s.name = r.origin;
UPDATE routes r SET destination_stop_id = s.id
FROM stops s WHERE s.name = r.destination;

ALTER TABLE routes
  ALTER COLUMN origin_stop_id SET NOT NULL,
  ALTER COLUMN destination_stop_id SET NOT NULL;

CREATE TABLE route_stops (
  route_id text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  stop_id text NOT NULL REFERENCES stops(id),
  stop_order smallint NOT NULL CHECK (stop_order >= 0),
  PRIMARY KEY (route_id, stop_order),
  UNIQUE (route_id, stop_id)
);

CREATE INDEX route_stops_stop_id_idx ON route_stops (stop_id);

INSERT INTO route_stops (route_id, stop_id, stop_order)
SELECT id, origin_stop_id, 0 FROM routes;
INSERT INTO route_stops (route_id, stop_id, stop_order)
SELECT id, destination_stop_id, 1 FROM routes;

ALTER TABLE routes
  DROP COLUMN origin,
  DROP COLUMN destination;
