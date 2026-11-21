CREATE TABLE scanner_scans (
  scan_id text PRIMARY KEY,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  credential_type text NOT NULL CHECK (credential_type IN ('ticket', 'pass', 'unknown')),
  credential_id text,
  trip_id text NOT NULL,
  stop_id text NOT NULL,
  action text NOT NULL,
  scanned_at timestamptz NOT NULL,
  device_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'conflict')),
  code text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scanner_scans_credential_day_idx
  ON scanner_scans (credential_type, credential_id, scanned_at)
  WHERE status = 'accepted';

CREATE INDEX scanner_scans_trip_received_idx
  ON scanner_scans (trip_id, received_at DESC);
