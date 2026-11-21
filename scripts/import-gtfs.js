import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { analyzeGtfsFeed, findStructuralErrors, readGtfsZip, sha256 } from "../server/gtfs-import.js";

const { Pool } = pg;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const migrationFile = resolve(projectDirectory, "db", "migrations", "005_gtfs_import.sql");

function parseArgs(args) {
  const options = { file: "", sourceId: "", sourceName: "", dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (["--file", "--source-id", "--source-name"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--file") options.file = value;
      if (argument === "--source-id") options.sourceId = value;
      if (argument === "--source-name") options.sourceName = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!options.file) throw new Error("Provide --file <path-to-gtfs.zip>.");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(options.sourceId)) {
    throw new Error("--source-id is required and must use 1-80 lowercase letters, digits, '.', '_' or '-'.");
  }
  options.sourceName ||= options.sourceId;
  return options;
}

function json(value) {
  return JSON.stringify(value);
}

function parseInteger(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

function parseNumber(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanFlag(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "1" ? true : normalized === "0" ? false : null;
}

function parseDate(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{8}$/.test(normalized)) return null;
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
}

function recordsFor(tables, fileName) {
  return tables.get(fileName)?.rows ?? [];
}

function recordId(fileName, row) {
  const fields = {
    "agency.txt": "agency_id",
    "routes.txt": "route_id",
    "stops.txt": "stop_id",
    "trips.txt": "trip_id",
    "stop_times.txt": "trip_id",
    "calendar.txt": "service_id",
    "calendar_dates.txt": "service_id",
    "frequencies.txt": "trip_id",
    "shapes.txt": "shape_id",
  };
  return String(row[fields[fileName]] ?? "").trim() || null;
}

async function insertRows(client, table, columns, rows, chunkSize = 700) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values = [];
    const groups = chunk.map((row, rowIndex) => {
      const placeholders = columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`);
      values.push(...row);
      return `(${placeholders.join(", ")})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${groups.join(", ")}`, values);
  }
}

async function applyGtfsMigration(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["ride-addis-schema-migrations"]);
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", ["005_gtfs_import.sql"]);
    if (!existing.rowCount) {
      await client.query(await readFile(migrationFile, "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", ["005_gtfs_import.sql"]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadExistingFeeds(pool, exceptFeedId) {
  const feedsResult = await pool.query(
    "SELECT feed_id FROM gtfs_feeds WHERE feed_id <> $1 ORDER BY feed_id",
    [exceptFeedId],
  );
  const existing = new Map(feedsResult.rows.map(({ feed_id }) => [feed_id, { feedId: feed_id, tables: new Map() }]));
  if (!existing.size) return [];
  const records = await pool.query(
    `SELECT feed_id, file_name, record_data
     FROM gtfs_source_records
     WHERE feed_id <> $1 AND file_name IN ('routes.txt', 'stops.txt', 'trips.txt')
     ORDER BY feed_id, file_name, source_row`,
    [exceptFeedId],
  );
  for (const { feed_id, file_name, record_data } of records.rows) {
    const feed = existing.get(feed_id);
    const parsed = feed.tables.get(file_name) ?? [];
    parsed.push(record_data);
    feed.tables.set(file_name, parsed);
  }
  return [...existing.values()].map(({ feedId, tables }) => ({
    feedId,
    tables: new Map([...tables].map(([fileName, rows]) => [fileName, rows])),
  }));
}

async function persistFeed(pool, options, archive, report) {
  const client = await pool.connect();
  const { tables } = archive;
  const fileInventory = [...tables].map(([fileName, parsed]) => ({
    file: fileName,
    rows: parsed.rows.length,
    columns: parsed.headers,
  }));
  const feedInfo = recordsFor(tables, "feed_info.txt")[0] ?? {};
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO gtfs_feeds (feed_id, source_name, content_sha256, feed_info, file_inventory, validation_report)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
       ON CONFLICT (feed_id) DO UPDATE SET
         source_name = EXCLUDED.source_name,
         content_sha256 = EXCLUDED.content_sha256,
         feed_info = EXCLUDED.feed_info,
         file_inventory = EXCLUDED.file_inventory,
         validation_report = EXCLUDED.validation_report,
         imported_at = now()`,
      [options.sourceId, options.sourceName, archive.archiveSha256, json(feedInfo), json(fileInventory), json(report)],
    );
    for (const table of [
      "gtfs_source_records",
      "gtfs_routes",
      "gtfs_stops",
      "gtfs_trips",
      "gtfs_stop_times",
      "gtfs_service_calendars",
      "gtfs_service_exceptions",
      "gtfs_frequencies",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE feed_id = $1`, [options.sourceId]);
    }

    const rawRows = [];
    for (const [fileName, parsed] of tables) {
      parsed.rows.forEach((row, index) => {
        const rowJson = json(row);
        rawRows.push([
          options.sourceId,
          fileName,
          index + 2,
          recordId(fileName, row),
          rowJson,
          sha256(rowJson),
        ]);
      });
    }
    await insertRows(client, "gtfs_source_records", [
      "feed_id", "file_name", "source_row", "source_record_id", "record_data", "record_sha256",
    ], rawRows);

    const sourceData = (row) => json(row);
    await insertRows(client, "gtfs_routes", [
      "feed_id", "source_row", "source_route_id", "agency_id", "short_name", "long_name", "route_type", "source_data",
    ], recordsFor(tables, "routes.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.route_id ?? "").trim(), String(row.agency_id ?? "").trim() || null,
      String(row.route_short_name ?? "").trim() || null, String(row.route_long_name ?? "").trim() || null,
      parseInteger(row.route_type), sourceData(row),
    ]));
    await insertRows(client, "gtfs_stops", [
      "feed_id", "source_row", "source_stop_id", "stop_name", "latitude", "longitude", "location_type", "parent_station", "source_data",
    ], recordsFor(tables, "stops.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.stop_id ?? "").trim(), String(row.stop_name ?? "").trim() || null,
      parseNumber(row.stop_lat), parseNumber(row.stop_lon), parseInteger(row.location_type),
      String(row.parent_station ?? "").trim() || null, sourceData(row),
    ]));
    await insertRows(client, "gtfs_trips", [
      "feed_id", "source_row", "source_trip_id", "source_route_id", "service_id", "headsign", "short_name", "direction_id", "shape_id", "source_data",
    ], recordsFor(tables, "trips.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.trip_id ?? "").trim(), String(row.route_id ?? "").trim(),
      String(row.service_id ?? "").trim(), String(row.trip_headsign ?? "").trim() || null,
      String(row.trip_short_name ?? "").trim() || null, parseInteger(row.direction_id),
      String(row.shape_id ?? "").trim() || null, sourceData(row),
    ]));
    await insertRows(client, "gtfs_stop_times", [
      "feed_id", "source_row", "source_trip_id", "arrival_time", "departure_time", "source_stop_id", "stop_sequence", "source_data",
    ], recordsFor(tables, "stop_times.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.trip_id ?? "").trim(),
      String(row.arrival_time ?? "").trim() || null, String(row.departure_time ?? "").trim() || null,
      String(row.stop_id ?? "").trim(), parseInteger(row.stop_sequence), sourceData(row),
    ]));
    await insertRows(client, "gtfs_service_calendars", [
      "feed_id", "source_row", "service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
      "saturday", "sunday", "start_date", "end_date", "source_data",
    ], recordsFor(tables, "calendar.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.service_id ?? "").trim(),
      ...["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => parseBooleanFlag(row[day])),
      parseDate(row.start_date), parseDate(row.end_date), sourceData(row),
    ]));
    await insertRows(client, "gtfs_service_exceptions", [
      "feed_id", "source_row", "service_id", "service_date", "exception_type", "source_data",
    ], recordsFor(tables, "calendar_dates.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.service_id ?? "").trim(),
      parseDate(row.date), parseInteger(row.exception_type), sourceData(row),
    ]));
    await insertRows(client, "gtfs_frequencies", [
      "feed_id", "source_row", "source_trip_id", "start_time", "end_time", "headway_seconds", "exact_times", "source_data",
    ], recordsFor(tables, "frequencies.txt").map((row, index) => [
      options.sourceId, index + 2, String(row.trip_id ?? "").trim(),
      String(row.start_time ?? "").trim(), String(row.end_time ?? "").trim(),
      parseInteger(row.headway_secs), parseInteger(row.exact_times), sourceData(row),
    ]));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nUsage: npm run gtfs:import -- --source-id <stable-id> --source-name <label> --file <feed.zip> [--dry-run]`);
    process.exitCode = 2;
    return;
  }

  const archive = await readGtfsZip(resolve(options.file));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/city%20bus",
    connectionTimeoutMillis: 5000,
  });
  try {
    await applyGtfsMigration(pool);
    const existingFeeds = await loadExistingFeeds(pool, options.sourceId);
    const report = analyzeGtfsFeed({
      feedId: options.sourceId,
      sourceName: options.sourceName,
      tables: archive.tables,
      existingFeeds,
    });
    report.archiveSha256 = archive.archiveSha256;
    report.archiveBytes = archive.archiveBytes;
    report.dryRun = options.dryRun;
    console.log(JSON.stringify(report, null, 2));
    const errors = findStructuralErrors(report);
    if (errors.length) {
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun) await persistFeed(pool, options, archive, report);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`GTFS import failed: ${error.message}`);
  process.exitCode = 1;
});
