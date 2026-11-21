import "dotenv/config";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import {
  hashScannerPassword,
  issueConductorToken,
  scannerTokenTtlSeconds,
  verifyConductorToken,
  verifyScannerPassword,
} from "./scanner-auth.js";
import { getNetworkConfig } from "./network-config.js";
import { buildGtfsRouteView } from "./gtfs-schedules.js";
import { getSubscriptionEstimate } from "../src/subscription.js";
import { journeyTypeForRoundTrip, parseScannerCredential, scannerQrNote } from "../src/scanner-protocol.js";
import { getMonthlyPassStatus } from "../src/ticket-status.js";

const { Pool } = pg;
const serverDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(serverDirectory, "..");
const port = Number(process.env.PORT ?? 5000);
const networkConfig = getNetworkConfig();
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/city%20bus";
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
const app = express();
const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const scannerSigningKeyId = process.env.SCANNER_SIGNING_KEY_ID ?? "ride-addis-scanner-v1";
let scannerSigningPrivateKey;
let scannerPublicKeyBase64;
let dummyScannerPasswordHash;
const loginAttempts = new Map();
const loginAttemptWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 5;

app.use(express.json({ limit: "128kb" }));
app.use((request, response, next) => {
  const origin = request.get("Origin");
  if (origin && !networkConfig.allowedOrigins.has(origin)) {
    response.status(403).json({ error: "This browser origin is not allowed." });
    return;
  }
  if (origin) {
    response.vary("Origin");
    response.set("Access-Control-Allow-Origin", origin);
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
  if (request.method === "OPTIONS") {
    response.sendStatus(origin ? 204 : 403);
    return;
  }
  next();
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function limitScannerLogin(request, response, next) {
  const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  let attempt = loginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + loginAttemptWindowMs };
    loginAttempts.set(key, attempt);
  }
  if (attempt.count >= maxLoginAttempts) {
    response.set("Retry-After", String(Math.ceil((attempt.resetAt - now) / 1000)));
    response.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }
  attempt.count += 1;
  next();
}

function requireConductor(request, response, next) {
  const authorization = request.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const claims = match && verifyConductorToken(match[1], process.env.JWT_SECRET);
  if (!claims) {
    response.status(401).json({ error: "A valid conductor bearer token is required." });
    return;
  }
  request.conductor = claims;
  next();
}

function currentAddisMonth() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Addis_Ababa",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find(({ type }) => type === "year")?.value;
  const month = parts.find(({ type }) => type === "month")?.value;
  return `${year}-${month}`;
}

function addisDateForTimestamp(timestamp) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Addis_Ababa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const year = parts.find(({ type }) => type === "year")?.value;
  const month = parts.find(({ type }) => type === "month")?.value;
  const day = parts.find(({ type }) => type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function currentAddisDate() {
  return addisDateForTimestamp(new Date());
}

function addisDayExpiry(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1) - 3 * 60 * 60 * 1000).toISOString();
}

function initializeScannerSigningKey() {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(scannerSigningKeyId)) {
    throw new Error("SCANNER_SIGNING_KEY_ID must contain only letters, numbers, '.', '_' or '-'.");
  }
  const encodedPrivateKey = process.env.SCANNER_SIGNING_PRIVATE_KEY_BASE64;
  if (!encodedPrivateKey || encodedPrivateKey.startsWith("REPLACE_")) {
    throw new Error("Set SCANNER_SIGNING_PRIVATE_KEY_BASE64 to a real Ed25519 PKCS#8 private key.");
  }
  scannerSigningPrivateKey = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (scannerSigningPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("SCANNER_SIGNING_PRIVATE_KEY_BASE64 must be an Ed25519 key.");
  }
  scannerPublicKeyBase64 = createPublicKey(scannerSigningPrivateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64url");
}

async function applyMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const directory = resolve(projectDirectory, "db", "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const alreadyApplied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (alreadyApplied.rowCount) continue;

    const migration = await readFile(resolve(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function seedRoutes() {
  const { stops, routes } = JSON.parse(await readFile(resolve(projectDirectory, "db", "seed-routes.json"), "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stopIds = new Set();
    for (const stop of stops) {
      await client.query(
        `INSERT INTO stops (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [stop.id, stop.name],
      );
      stopIds.add(stop.id);
    }

    for (const route of routes) {
      if (route.stops.length < 2 || route.stops.some((stopId) => !stopIds.has(stopId))) {
        throw new Error(`Route ${route.id} must reference at least two seeded stops.`);
      }
      await client.query(
        `INSERT INTO routes (id, origin_stop_id, destination_stop_id, duration_minutes, fare, trips)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           origin_stop_id = EXCLUDED.origin_stop_id,
           destination_stop_id = EXCLUDED.destination_stop_id,
           duration_minutes = EXCLUDED.duration_minutes,
           fare = EXCLUDED.fare,
           trips = EXCLUDED.trips,
           updated_at = now()`,
        [route.id, route.stops[0], route.stops[route.stops.length - 1], route.duration, route.fare, JSON.stringify(route.trips)],
      );
      await client.query("DELETE FROM route_stops WHERE route_id = $1", [route.id]);
      for (const [stopOrder, stopId] of route.stops.entries()) {
        await client.query(
          "INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES ($1, $2, $3)",
          [route.id, stopId, stopOrder],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initializeDatabase() {
  await applyMigrations();
  await seedRoutes();
}

function ticketSelect() {
  return `
    SELECT t.id, t.route_id AS "routeId", origin.name AS "from", destination.name AS "to",
      to_char(t.travel_date, 'YYYY-MM-DD') AS "travelDate",
      t.departure_time AS departure, t.arrival_time AS arrival, t.trip_id AS "tripId",
      t.seat, t.passenger_name AS passenger, t.amount_paid AS amount, t.status,
      to_char(t.used_at AT TIME ZONE 'Africa/Addis_Ababa', 'YYYY-MM-DD') AS "usedAt",
      t.created_at AS "createdAt"
    FROM tickets t
    JOIN routes r ON r.id = t.route_id
    JOIN stops origin ON origin.id = r.origin_stop_id
    JOIN stops destination ON destination.id = r.destination_stop_id
  `;
}

function serializeTicket(row) {
  return {
    ...row,
    amount: Number(row.amount),
    usedAt: row.usedAt ?? null,
  };
}

function subscriptionSelect() {
  return `
    SELECT s.id, s.route_id AS "routeId", origin.name AS "from", destination.name AS "to",
      s.month, s.weekdays, s.round_trip AS "roundTrip", s.amount_paid AS price,
      s.created_at AS "createdAt"
    FROM monthly_subscriptions s
    JOIN routes r ON r.id = s.route_id
    JOIN stops origin ON origin.id = r.origin_stop_id
    JOIN stops destination ON destination.id = r.destination_stop_id
  `;
}

function serializeSubscription(row) {
  return {
    ...row,
    route: `${row.from} → ${row.to}`,
    days: row.weekdays.map((day) => dayLabels[day]).join(", "),
    price: Number(row.price),
    status: getMonthlyPassStatus(row.month, currentAddisMonth()),
  };
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateTicketBody(body) {
  if (typeof body?.routeId !== "string" || typeof body?.tripId !== "string") {
    throw httpError(400, "A route and trip are required.");
  }
  if (!isCalendarDate(body.travelDate)) throw httpError(400, "Choose a valid travel date.");
  if (typeof body.seat !== "string" || !/^(0[1-9]|1[0-9]|2[0-4])$/.test(body.seat)) {
    throw httpError(400, "Choose a valid seat.");
  }
  if (typeof body.passenger !== "string" || body.passenger.trim().length < 1 || body.passenger.trim().length > 60) {
    throw httpError(400, "Enter a passenger name of 1 to 60 characters.");
  }
}

function validateScannerBatch(body) {
  if (!Array.isArray(body?.scans) || body.scans.length < 1 || body.scans.length > 50) {
    throw httpError(400, "Provide between one and 50 scan events.");
  }
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const scanIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const [index, scan] of body.scans.entries()) {
    if (!scan || typeof scan !== "object" || Array.isArray(scan) ||
        typeof scan.scanId !== "string" || !scanIdPattern.test(scan.scanId) ||
        typeof scan.credential !== "string" || scan.credential.length > 2048 ||
        typeof scan.tripId !== "string" || scan.tripId.length < 1 || scan.tripId.length > 120 ||
        typeof scan.stopId !== "string" || scan.stopId.length < 1 || scan.stopId.length > 120 ||
        typeof scan.action !== "string" || scan.action.length < 1 || scan.action.length > 32 ||
        typeof scan.scannedAt !== "string" || !timestampPattern.test(scan.scannedAt) ||
        !isCalendarDate(scan.scannedAt.slice(0, 10)) ||
        !Number.isFinite(Date.parse(scan.scannedAt)) ||
        typeof scan.deviceId !== "string" || scan.deviceId.length < 1 || scan.deviceId.length > 120) {
      throw httpError(400, `Scan event ${index} has an invalid shape.`);
    }
  }
  return body.scans;
}

function scannerResult(scanId, status, code, credential, replayed = false) {
  return {
    scanId,
    status,
    code,
    credentialType: credential?.type ?? null,
    credentialId: credential?.id ?? null,
    replayed,
  };
}

function scannerResultFromRow(row) {
  return {
    scanId: row.scan_id,
    status: row.status,
    code: row.code,
    credentialType: row.credential_type === "unknown" ? null : row.credential_type,
    credentialId: row.credential_id,
    replayed: true,
  };
}

async function processScannerScan(scan) {
  const credential = parseScannerCredential(scan.credential);
  const credentialType = credential?.type ?? "unknown";
  const credentialId = credential?.id ?? null;
  const requestHash = createHash("sha256")
    .update(JSON.stringify([
      scan.scanId, scan.credential, scan.tripId, scan.stopId,
      scan.action, scan.scannedAt, scan.deviceId,
    ]))
    .digest("hex");
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const existing = await client.query(
      `SELECT scan_id, request_hash, credential_type, credential_id, status, code
       FROM scanner_scans WHERE scan_id = $1`,
      [scan.scanId],
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      if (existing.rows[0].request_hash === requestHash) return scannerResultFromRow(existing.rows[0]);
      return scannerResult(scan.scanId, "conflict", "scan_id_reused", credential);
    }

    const inserted = await client.query(
      `INSERT INTO scanner_scans
         (scan_id, request_hash, credential_type, credential_id, trip_id, stop_id, action, scanned_at, device_id, status, code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rejected', 'processing')
       ON CONFLICT (scan_id) DO NOTHING
       RETURNING scan_id`,
      [scan.scanId, requestHash, credentialType, credentialId, scan.tripId, scan.stopId, scan.action, scan.scannedAt, scan.deviceId],
    );
    if (!inserted.rowCount) {
      const raced = await client.query(
        `SELECT scan_id, request_hash, credential_type, credential_id, status, code
         FROM scanner_scans WHERE scan_id = $1`,
        [scan.scanId],
      );
      await client.query("ROLLBACK");
      transactionOpen = false;
      if (raced.rows[0]?.request_hash === requestHash) return scannerResultFromRow(raced.rows[0]);
      return scannerResult(scan.scanId, "conflict", "scan_id_reused", credential);
    }

    let outcome = { status: "rejected", code: "invalid_credential" };
    if (credential && scan.action !== "board") {
      outcome.code = "unsupported_action";
    } else if (credential) {
      const routeResult = await client.query(
        `SELECT r.id, origin.name AS "from", destination.name AS "to"
         FROM routes r
         JOIN stops origin ON origin.id = r.origin_stop_id
         JOIN stops destination ON destination.id = r.destination_stop_id
         WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements(r.trips) AS trip(item)
           WHERE item->>'id' = $1
         )
         FOR SHARE OF r`,
        [scan.tripId],
      );
      if (!routeResult.rowCount) {
        outcome.code = "unknown_trip";
      } else if (routeResult.rowCount > 1) {
        outcome.code = "ambiguous_trip";
      } else {
        const route = routeResult.rows[0];
        const routeName = `${route.from} to ${route.to}`;
        const stopResult = await client.query(
          "SELECT 1 FROM route_stops WHERE route_id = $1 AND stop_id = $2",
          [route.id, scan.stopId],
        );
        if (!stopResult.rowCount) {
          outcome.code = "wrong_stop";
        } else if (credential.qr.route !== routeName) {
          outcome.code = "wrong_route";
        } else if (credential.type === "ticket") {
          const ticketResult = await client.query(
            `SELECT t.id, t.route_id AS "routeId", t.trip_id AS "tripId",
               t.travel_date::text AS "travelDate", t.seat, t.status
             FROM tickets t
             WHERE t.id = $1
             FOR UPDATE OF t`,
            [credential.id],
          );
          if (!ticketResult.rowCount) {
            outcome.code = "credential_not_found";
          } else {
            const ticket = ticketResult.rows[0];
            if (ticket.routeId !== route.id || ticket.tripId !== scan.tripId || ticket.seat !== credential.qr.seat) {
              outcome.code = "ticket_mismatch";
            } else if (ticket.travelDate !== addisDateForTimestamp(scan.scannedAt)) {
              outcome.code = "ticket_wrong_date";
            } else if (ticket.status !== "valid") {
              outcome = { status: "conflict", code: "ticket_already_used" };
            } else {
              await client.query(
                "UPDATE tickets SET status = 'used', used_at = $2 WHERE id = $1 AND status = 'valid'",
                [ticket.id, scan.scannedAt],
              );
              outcome = { status: "accepted", code: "ticket_valid" };
            }
          }
        } else {
          const passResult = await client.query(
            `SELECT id, route_id AS "routeId", month, weekdays, round_trip AS "roundTrip"
             FROM monthly_subscriptions
             WHERE id = $1
             FOR UPDATE`,
            [credential.id],
          );
          if (!passResult.rowCount) {
            outcome.code = "credential_not_found";
          } else {
            const pass = passResult.rows[0];
            const scanDate = addisDateForTimestamp(scan.scannedAt);
            const scanWeekday = new Date(`${scanDate}T00:00:00.000Z`).getUTCDay();
            const passDays = pass.weekdays.map((day) => dayLabels[day]).join(", ");
            if (pass.routeId !== route.id || credential.qr.month !== pass.month ||
                credential.qr.weekdays !== passDays ||
                credential.qr.journeyType !== journeyTypeForRoundTrip(pass.roundTrip)) {
              outcome.code = "pass_mismatch";
            } else if (pass.month !== scanDate.slice(0, 7) || !pass.weekdays.includes(scanWeekday)) {
              outcome.code = "pass_not_eligible";
            } else {
              const priorResult = await client.query(
                `SELECT count(*)::integer AS uses,
                   COALESCE(bool_or(trip_id = $2 AND stop_id = $3), false) AS same_trip_stop
                 FROM scanner_scans
                 WHERE credential_type = 'pass' AND credential_id = $1 AND status = 'accepted'
                   AND (scanned_at AT TIME ZONE 'Africa/Addis_Ababa')::date = $4::date`,
                [pass.id, scan.tripId, scan.stopId, scanDate],
              );
              const prior = priorResult.rows[0];
              if (prior.same_trip_stop) {
                outcome = { status: "conflict", code: "pass_already_scanned_at_stop" };
              } else if (prior.uses >= (pass.roundTrip ? 2 : 1)) {
                outcome = { status: "conflict", code: "pass_daily_limit" };
              } else {
                outcome = { status: "accepted", code: "pass_valid" };
              }
            }
          }
        }
      }
    }

    await client.query(
      "UPDATE scanner_scans SET status = $2, code = $3 WHERE scan_id = $1",
      [scan.scanId, outcome.status, outcome.code],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return scannerResult(scan.scanId, outcome.status, outcome.code, credential);
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/api/health", asyncRoute(async (_request, response) => {
  await pool.query("SELECT 1");
  response.json({ status: "ok", database: "connected" });
}));

app.get("/api/routes", asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(
    `SELECT r.id, origin.name AS "from", destination.name AS "to",
       COALESCE((
         SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY rs.stop_order)
         FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
         WHERE rs.route_id = r.id
       ), '[]'::json) AS stops,
       r.duration_minutes AS duration, r.fare, r.trips
     FROM routes r
     JOIN stops origin ON origin.id = r.origin_stop_id
     JOIN stops destination ON destination.id = r.destination_stop_id
     ORDER BY r.id`,
  );
  response.json(rows.map((route) => ({ ...route, duration: Number(route.duration), fare: Number(route.fare) })));
}));

app.get("/api/gtfs/routes", asyncRoute(async (request, response) => {
  const date = request.query.date ?? currentAddisDate();
  const parsedDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00.000Z`)
    : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw httpError(400, "date must be a valid YYYY-MM-DD date.");
  }
  const [feedsResult, routesResult, stopsResult, tripsResult, timesResult, calendarsResult, exceptionsResult, frequenciesResult] =
    await Promise.all([
      pool.query(`SELECT feed_id, source_name, content_sha256, validation_report
        FROM gtfs_feeds ORDER BY feed_id`),
      pool.query(`SELECT feed_id, source_route_id, short_name, long_name, route_type
        FROM gtfs_routes ORDER BY feed_id, source_row`),
      pool.query(`SELECT feed_id, source_stop_id, stop_name, source_row
        FROM gtfs_stops ORDER BY feed_id, source_row`),
      pool.query(`SELECT feed_id, source_trip_id, source_route_id, service_id, headsign, short_name,
          direction_id, source_row
        FROM gtfs_trips ORDER BY feed_id, source_row`),
      pool.query(`SELECT feed_id, source_trip_id, arrival_time, departure_time, source_stop_id,
          stop_sequence, source_row
        FROM gtfs_stop_times ORDER BY feed_id, source_trip_id, stop_sequence, source_row`),
      pool.query(`SELECT feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday,
          sunday, start_date, end_date
        FROM gtfs_service_calendars ORDER BY feed_id, source_row`),
      pool.query(`SELECT feed_id, service_id, service_date, exception_type
        FROM gtfs_service_exceptions ORDER BY feed_id, source_row`),
      pool.query(`SELECT feed_id, source_trip_id, start_time, end_time, headway_seconds, exact_times, source_row
        FROM gtfs_frequencies ORDER BY feed_id, source_row`),
    ]);
  const routes = buildGtfsRouteView({
    date,
    feeds: feedsResult.rows,
    routes: routesResult.rows,
    stops: stopsResult.rows,
    trips: tripsResult.rows,
    stopTimes: timesResult.rows,
    calendars: calendarsResult.rows,
    exceptions: exceptionsResult.rows,
    frequencies: frequenciesResult.rows,
  });
  response.json({
    date,
    feeds: feedsResult.rows.map((feed) => ({
      id: feed.feed_id,
      name: feed.source_name,
      dateCoverage: feed.validation_report?.dateCoverage ?? null,
      summary: feed.validation_report?.summary ?? null,
      collisions: feed.validation_report?.collisions ?? [],
      issues: feed.validation_report?.issues ?? [],
    })),
    routes,
  });
}));

app.get("/api/tickets", asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(`${ticketSelect()} ORDER BY t.created_at DESC`);
  response.json(rows.map(serializeTicket));
}));

app.post("/api/tickets", asyncRoute(async (request, response) => {
  validateTicketBody(request.body);
  const { routeId, tripId, travelDate, seat, passenger } = request.body;
  const routeResult = await pool.query("SELECT fare, trips FROM routes WHERE id = $1", [routeId]);
  if (!routeResult.rowCount) throw httpError(404, "The selected sample route was not found.");
  const route = routeResult.rows[0];
  const trip = route.trips.find((candidate) => candidate.id === tripId);
  if (!trip) throw httpError(400, "The selected trip is not available on this route.");

  const id = `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`;
  await pool.query(
    `INSERT INTO tickets (id, route_id, trip_id, travel_date, departure_time, arrival_time, seat, passenger_name, amount_paid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, routeId, tripId, travelDate, trip.departure, trip.arrival, seat, passenger.trim(), route.fare],
  );
  const { rows } = await pool.query(`${ticketSelect()} WHERE t.id = $1`, [id]);
  response.status(201).json(serializeTicket(rows[0]));
}));

app.post("/api/tickets/:id/use", asyncRoute(async (request, response) => {
  const result = await pool.query(
    `UPDATE tickets SET status = 'used', used_at = now()
     WHERE id = $1 AND status = 'valid'
     RETURNING id`,
    [request.params.id],
  );
  if (!result.rowCount) {
    const existing = await pool.query("SELECT status FROM tickets WHERE id = $1", [request.params.id]);
    if (!existing.rowCount) throw httpError(404, "Ticket not found.");
    throw httpError(409, "This demo ticket has already been used.");
  }
  const { rows } = await pool.query(`${ticketSelect()} WHERE t.id = $1`, [request.params.id]);
  response.json(serializeTicket(rows[0]));
}));

app.get("/api/subscriptions", asyncRoute(async (_request, response) => {
  const { rows } = await pool.query(`${subscriptionSelect()} ORDER BY s.created_at DESC`);
  response.json(rows.map(serializeSubscription));
}));

app.post("/api/subscriptions", asyncRoute(async (request, response) => {
  const { routeId, month, weekdays, roundTrip } = request.body ?? {};
  if (typeof routeId !== "string") throw httpError(400, "Choose a route.");
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw httpError(400, "Choose a valid starting month.");
  }
  if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7 ||
      weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(weekdays).size !== weekdays.length) {
    throw httpError(400, "Select one to seven unique weekdays.");
  }
  if (typeof roundTrip !== "boolean") throw httpError(400, "Choose one-way or round-trip travel.");

  const routeResult = await pool.query("SELECT fare FROM routes WHERE id = $1", [routeId]);
  if (!routeResult.rowCount) throw httpError(404, "The selected sample route was not found.");
  const price = getSubscriptionEstimate({
    fare: Number(routeResult.rows[0].fare),
    month,
    weekdays,
    roundTrip,
  }).total;
  const id = `PASS-${randomUUID().slice(0, 8).toUpperCase()}`;
  await pool.query(
    `INSERT INTO monthly_subscriptions (id, route_id, month, weekdays, round_trip, amount_paid)
     VALUES ($1, $2, $3, $4::smallint[], $5, $6)`,
    [id, routeId, month, weekdays, roundTrip, price],
  );
  const { rows } = await pool.query(`${subscriptionSelect()} WHERE s.id = $1`, [id]);
  response.status(201).json(serializeSubscription(rows[0]));
}));

app.post("/api/scanner/auth/login", limitScannerLogin, asyncRoute(async (request, response) => {
  const username = typeof request.body?.username === "string"
    ? request.body.username.trim().toLowerCase()
    : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const result = username
    ? await pool.query(
      "SELECT id, username, password_hash, role, is_active FROM scanner_users WHERE username = $1",
      [username],
    )
    : { rows: [] };
  const user = result.rows[0];
  const passwordMatches = await verifyScannerPassword(
    password,
    user?.password_hash ?? dummyScannerPasswordHash,
  );
  if (!user || !user.is_active || user.role !== "conductor" || !passwordMatches) {
    response.status(401).json({ error: "Invalid username or password." });
    return;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  response.json({
    accessToken: issueConductorToken(user, process.env.JWT_SECRET, issuedAt),
    tokenType: "Bearer",
    expiresAt: new Date((issuedAt + scannerTokenTtlSeconds) * 1000).toISOString(),
    role: "conductor",
  });
}));

app.get("/api/scanner/keys/:keyId", (_request, response, next) => {
  if (_request.params.keyId !== scannerSigningKeyId) {
    next(httpError(404, "Scanner signing key not found."));
    return;
  }
  response.set("Cache-Control", "public, max-age=31536000, immutable");
  response.json({
    keyId: scannerSigningKeyId,
    algorithm: "Ed25519",
    publicKey: scannerPublicKeyBase64,
  });
});

app.get("/api/scanner/trips/:tripId/manifest", requireConductor, asyncRoute(async (request, response) => {
  const travelDate = request.query.date === undefined ? currentAddisDate() : request.query.date;
  if (!isCalendarDate(travelDate) || travelDate < currentAddisDate()) {
    throw httpError(400, "Provide a valid travel date that is today or later in Addis Ababa.");
  }
  const routeResult = await pool.query(
    `SELECT r.id, origin.name AS "from", destination.name AS "to"
     FROM routes r
     JOIN stops origin ON origin.id = r.origin_stop_id
     JOIN stops destination ON destination.id = r.destination_stop_id
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(r.trips) AS trip(item)
       WHERE item->>'id' = $1
     )`,
    [request.params.tripId],
  );
  if (!routeResult.rowCount) throw httpError(404, "Trip not found.");
  if (routeResult.rowCount > 1) throw httpError(409, "Trip identifier is ambiguous.");
  const route = routeResult.rows[0];
  const routeName = `${route.from} to ${route.to}`;
  const weekday = new Date(`${travelDate}T00:00:00.000Z`).getUTCDay();
  const [stopResult, ticketResult, passResult] = await Promise.all([
    pool.query(
      `SELECT s.id, s.name, rs.stop_order AS "order"
       FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
       WHERE rs.route_id = $1 ORDER BY rs.stop_order`,
      [route.id],
    ),
    pool.query(
      `SELECT id, seat FROM tickets
       WHERE route_id = $1 AND trip_id = $2 AND travel_date = $3::date AND status = 'valid'
       ORDER BY id`,
      [route.id, request.params.tripId, travelDate],
    ),
    pool.query(
      `SELECT id, month, weekdays, round_trip AS "roundTrip" FROM monthly_subscriptions
       WHERE route_id = $1 AND month = $2 ORDER BY id`,
      [route.id, travelDate.slice(0, 7)],
    ),
  ]);
  const credentials = ticketResult.rows.map((ticket) => ({
    type: "ticket",
    id: ticket.id,
    qr: {
      demo: true,
      ticket: ticket.id,
      route: routeName,
      seat: ticket.seat,
      note: scannerQrNote,
    },
  }));
  for (const pass of passResult.rows) {
    if (!pass.weekdays.includes(weekday)) continue;
    const journeyType = journeyTypeForRoundTrip(pass.roundTrip);
    credentials.push({
      type: "pass",
      id: pass.id,
      journeyType,
      qr: {
        demo: true,
        pass: pass.id,
        route: routeName,
        month: pass.month,
        weekdays: pass.weekdays.map((day) => dayLabels[day]).join(", "),
        journeyType,
        note: scannerQrNote,
      },
    });
  }

  const manifest = {
    demo: true,
    schemaVersion: 1,
    tripId: request.params.tripId,
    routeId: route.id,
    travelDate,
    issuedAt: new Date().toISOString(),
    expiresAt: addisDayExpiry(travelDate),
    stops: stopResult.rows.map((stop) => ({ ...stop, order: Number(stop.order) })),
    credentials,
  };
  const payloadBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  response.json({
    keyId: scannerSigningKeyId,
    algorithm: "Ed25519",
    payload: payloadBytes.toString("base64url"),
    signature: sign(null, payloadBytes, scannerSigningPrivateKey).toString("base64url"),
  });
}));

app.post("/api/scanner/scans/sync", requireConductor, asyncRoute(async (request, response) => {
  const scans = validateScannerBatch(request.body);
  const results = [];
  for (const scan of scans) results.push(await processScannerScan(scan));
  response.json({ results });
}));

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API endpoint not found." });
});

app.use(express.static(resolve(projectDirectory, "dist")));
app.get("*", (_request, response) => {
  response.sendFile(resolve(projectDirectory, "dist", "index.html"));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status ?? 500).json({
    error: error.status ? error.message : "The local API could not complete the request. Check the server log.",
  });
});

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /^(change|replace|your|placeholder)/i.test(process.env.JWT_SECRET)) {
    throw new Error("Set JWT_SECRET to a real secret of at least 32 characters in the environment.");
  }
  dummyScannerPasswordHash = await hashScannerPassword(randomUUID());
  initializeScannerSigningKey();
  await initializeDatabase();
  app.listen(port, networkConfig.host, () => {
    console.info(`Ride Addis API ready on ${networkConfig.host}:${port}`);
  });
}

start().catch(async (error) => {
  console.error("Could not start Ride Addis API. Check PostgreSQL and DATABASE_URL.", error);
  await pool.end();
  process.exitCode = 1;
});
