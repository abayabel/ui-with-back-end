import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

const requiredFiles = ["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt"];
const primaryKeys = {
  "routes.txt": "route_id",
  "stops.txt": "stop_id",
  "trips.txt": "trip_id",
  "calendar.txt": "service_id",
};
const recordIds = {
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
const fileLimits = { maxArchiveBytes: 40 * 1024 * 1024, maxEntryBytes: 20 * 1024 * 1024, maxTotalUncompressedBytes: 60 * 1024 * 1024 };

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseGtfsCsv(text, fileName = "GTFS file") {
  const input = text.replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed && character !== "," && character !== "\r" && character !== "\n") {
      throw new Error(`${fileName}: unexpected character after a quoted CSV field.`);
    }
    if (character === '"' && field.length === 0 && !quoteClosed) {
      inQuotes = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
      quoteClosed = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      quoteClosed = false;
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error(`${fileName}: unterminated quoted CSV field.`);
  if (field !== "" || record.length > 0) {
    record.push(field);
    if (record.some((value) => value !== "")) records.push(record);
  }
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error(`${fileName}: column names cannot be empty.`);
  if (new Set(headers).size !== headers.length) throw new Error(`${fileName}: duplicate column names are not allowed.`);
  const rows = records.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`${fileName}: row ${index + 2} has ${values.length} fields; expected ${headers.length}.`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  return { headers, rows };
}

export async function readGtfsZip(zipPath) {
  const archiveStat = await stat(zipPath);
  if (archiveStat.size > fileLimits.maxArchiveBytes) throw new Error("GTFS archive exceeds the 40 MiB safety limit.");
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });

  const entries = new Map();
  await new Promise((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
        zip.close();
      }
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on("entry", (entry) => {
      if (entry.fileName.endsWith("/")) {
        zip.readEntry();
        return;
      }
      const baseName = path.posix.basename(entry.fileName).toLowerCase();
      if (!baseName.endsWith(".txt")) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > fileLimits.maxEntryBytes) {
        fail(new Error(`${baseName} exceeds the 20 MiB safety limit.`));
        return;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > fileLimits.maxTotalUncompressedBytes) {
        fail(new Error("GTFS archive exceeds the 60 MiB uncompressed safety limit."));
        return;
      }
      if (entries.has(baseName)) {
        fail(new Error(`GTFS archive contains multiple ${baseName} files.`));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", fail);
        stream.on("end", () => {
          try {
            entries.set(baseName, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            zip.readEntry();
          } catch {
            fail(new Error(`${baseName} is not valid UTF-8.`));
          }
        });
      });
    });
    zip.readEntry();
  });

  for (const requiredFile of requiredFiles) {
    if (!entries.has(requiredFile)) throw new Error(`GTFS archive is missing required ${requiredFile}.`);
  }
  const tables = new Map();
  for (const [fileName, text] of entries) {
    tables.set(fileName, parseGtfsCsv(text, fileName));
  }
  return { tables, archiveSha256: await hashFile(zipPath), archiveBytes: archiveStat.size };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value) {
  const date = trimmed(value);
  if (!/^\d{8}$/.test(date)) return false;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function dateToIso(value) {
  const date = trimmed(value);
  if (!validDate(date)) return null;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function duplicates(rows, idField) {
  const byId = new Map();
  for (const row of rows ?? []) {
    const id = trimmed(row[idField]);
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  return [...byId].filter(([, values]) => values.length > 1).map(([id, values]) => ({
    id,
    count: values.length,
    distinctRecords: new Set(values.map((row) => JSON.stringify(row))).size,
  }));
}

function normalizedName(value) {
  return trimmed(value).normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function invalidTime(value) {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(trimmed(value));
  return !match || Number(match[1]) > 99;
}

export function analyzeGtfsFeed({ feedId, sourceName, tables, existingFeeds = [], now = new Date() }) {
  const tableRows = (fileName) => tables.get(fileName)?.rows ?? [];
  const issues = [];
  const collisions = [];
  const tableStats = Object.fromEntries([...tables].map(([file, parsed]) => [file, parsed.rows.length]));
  const routeRows = tableRows("routes.txt");
  const stopRows = tableRows("stops.txt");
  const tripRows = tableRows("trips.txt");
  const stopTimeRows = tableRows("stop_times.txt");
  const calendarRows = tableRows("calendar.txt");
  const exceptionRows = tableRows("calendar_dates.txt");
  const agencyRows = tableRows("agency.txt");

  const requiredColumns = {
    "agency.txt": ["agency_name", "agency_url", "agency_timezone"],
    "routes.txt": ["route_id", "route_type"],
    "stops.txt": ["stop_id", "stop_name"],
    "trips.txt": ["route_id", "service_id", "trip_id"],
    "stop_times.txt": ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
  };
  for (const [fileName, columns] of Object.entries(requiredColumns)) {
    const headers = tables.get(fileName)?.headers ?? [];
    const missing = columns.filter((column) => !headers.includes(column));
    if (missing.length) issues.push({ severity: "error", code: "missing_columns", file: fileName, columns: missing });
  }
  const requiredValues = [
    ["routes.txt", ["route_id", "route_type"]],
    ["stops.txt", ["stop_id", "stop_name"]],
    ["trips.txt", ["route_id", "service_id", "trip_id"]],
    ["stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]],
    ["calendar.txt", ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"]],
    ["calendar_dates.txt", ["service_id", "date", "exception_type"]],
  ];
  for (const [fileName, fields] of requiredValues) {
    for (const [index, row] of tableRows(fileName).entries()) {
      for (const field of fields) {
        if (!trimmed(row[field])) issues.push({ severity: "error", code: "missing_required_value", file: fileName, row: index + 2, field });
      }
    }
  }
  for (const [index, row] of routeRows.entries()) {
    if (!trimmed(row.route_short_name) && !trimmed(row.route_long_name)) {
      issues.push({ severity: "error", code: "missing_route_name", row: index + 2 });
    }
  }
  for (const [index, row] of stopRows.entries()) {
    const latitude = trimmed(row.stop_lat);
    const longitude = trimmed(row.stop_lon);
    if (latitude && (!Number.isFinite(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) {
      issues.push({ severity: "error", code: "invalid_stop_latitude", row: index + 2 });
    }
    if (longitude && (!Number.isFinite(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) {
      issues.push({ severity: "error", code: "invalid_stop_longitude", row: index + 2 });
    }
    if (trimmed(row.location_type) && !["0", "1", "2", "3", "4"].includes(trimmed(row.location_type))) {
      issues.push({ severity: "error", code: "invalid_location_type", row: index + 2 });
    }
  }

  for (const [fileName, idField] of Object.entries(primaryKeys)) {
    for (const duplicate of duplicates(tableRows(fileName), idField)) {
      collisions.push({ type: "duplicate_source_id", file: fileName, sourceId: duplicate.id, count: duplicate.count, distinctRecords: duplicate.distinctRecords });
    }
  }
  for (const fileName of ["routes.txt", "stops.txt", "trips.txt"]) {
    const ids = duplicates(tableRows(fileName), primaryKeys[fileName]);
    for (const duplicate of ids) {
      issues.push({ severity: "warning", code: "duplicate_source_id", file: fileName, sourceId: duplicate.id, count: duplicate.count });
    }
  }

  const routeIds = new Set(routeRows.map((row) => trimmed(row.route_id)).filter(Boolean));
  const stopIds = new Set(stopRows.map((row) => trimmed(row.stop_id)).filter(Boolean));
  const tripIds = new Set(tripRows.map((row) => trimmed(row.trip_id)).filter(Boolean));
  const serviceIds = new Set([...calendarRows, ...exceptionRows].map((row) => trimmed(row.service_id)).filter(Boolean));
  const agencyIds = new Set(agencyRows.map((row) => trimmed(row.agency_id)).filter(Boolean));
  const missingRouteTrips = tripRows.filter((row) => !routeIds.has(trimmed(row.route_id)));
  const missingServiceTrips = tripRows.filter((row) => !serviceIds.has(trimmed(row.service_id)));
  const missingStopTimeTrips = stopTimeRows.filter((row) => !tripIds.has(trimmed(row.trip_id)));
  const missingStops = stopTimeRows.filter((row) => !stopIds.has(trimmed(row.stop_id)));
  if (missingRouteTrips.length) issues.push({ severity: "error", code: "unknown_trip_route", count: missingRouteTrips.length });
  if (missingServiceTrips.length) issues.push({ severity: "error", code: "unknown_trip_service", count: missingServiceTrips.length });
  if (missingStopTimeTrips.length) issues.push({ severity: "error", code: "unknown_stop_time_trip", count: missingStopTimeTrips.length });
  if (missingStops.length) issues.push({ severity: "error", code: "unknown_stop_time_stop", count: missingStops.length });

  const routeAgencyIds = new Set(routeRows.map((row) => trimmed(row.agency_id)).filter(Boolean));
  if (agencyIds.size && [...routeAgencyIds].some((id) => !agencyIds.has(id))) {
    const missing = [...routeAgencyIds].filter((id) => !agencyIds.has(id));
    issues.push({ severity: "error", code: "unknown_route_agency", ids: missing.slice(0, 20), count: missing.length });
  }

  for (const [index, row] of stopTimeRows.entries()) {
    const sequence = Number(trimmed(row.stop_sequence));
    if (!Number.isInteger(sequence) || sequence < 0) {
      issues.push({ severity: "error", code: "invalid_stop_sequence", row: index + 2 });
      continue;
    }
    const stopSequenceKeys = new Set();
    for (const [index, row] of stopTimeRows.entries()) {
      const key = `${trimmed(row.trip_id)}\u0000${trimmed(row.stop_sequence)}`;
      if (stopSequenceKeys.has(key)) issues.push({ severity: "error", code: "duplicate_trip_stop_sequence", row: index + 2 });
      stopSequenceKeys.add(key);
    }
    if (invalidTime(row.arrival_time) || invalidTime(row.departure_time)) {
      issues.push({ severity: "error", code: "invalid_stop_time", row: index + 2 });
    }
  }
  for (const [fileName, field] of [["calendar.txt", "start_date"], ["calendar.txt", "end_date"], ["calendar_dates.txt", "date"]]) {
    for (const [index, row] of tableRows(fileName).entries()) {
      if (!validDate(row[field])) issues.push({ severity: "error", code: "invalid_service_date", file: fileName, row: index + 2, field });
    }
  }
  for (const [index, row] of calendarRows.entries()) {
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
      if (!["0", "1"].includes(trimmed(row[day]))) {
        issues.push({ severity: "error", code: "invalid_calendar_day_flag", row: index + 2, field: day });
      }
    }
    if (validDate(row.start_date) && validDate(row.end_date) && trimmed(row.start_date) > trimmed(row.end_date)) {
      issues.push({ severity: "error", code: "inverted_calendar_range", row: index + 2 });
    }
  }
  for (const [index, row] of exceptionRows.entries()) {
    if (!["1", "2"].includes(trimmed(row.exception_type))) {
      issues.push({ severity: "error", code: "invalid_exception_type", row: index + 2 });
    }
    const knownTripIds = new Set(tripRows.map((row) => trimmed(row.trip_id)));
    const frequencyRows = tableRows("frequencies.txt");
    for (const [index, row] of frequencyRows.entries()) {
      if (!knownTripIds.has(trimmed(row.trip_id))) issues.push({ severity: "error", code: "unknown_frequency_trip", row: index + 2 });
      if (invalidTime(row.start_time) || invalidTime(row.end_time)) {
        issues.push({ severity: "error", code: "invalid_frequency_time", row: index + 2 });
      }
      if (!/^[1-9]\d*$/.test(trimmed(row.headway_secs))) {
        issues.push({ severity: "error", code: "invalid_frequency_headway", row: index + 2 });
      }
      if (trimmed(row.exact_times) && !["0", "1"].includes(trimmed(row.exact_times))) {
        issues.push({ severity: "error", code: "invalid_frequency_exact_times", row: index + 2 });
      }
    }
  }
  for (const [index, row] of routeRows.entries()) {
    if (!/^\d+$/.test(trimmed(row.route_type))) issues.push({ severity: "error", code: "invalid_route_type", row: index + 2 });
  }
  for (const [index, row] of tripRows.entries()) {
    if (trimmed(row.direction_id) && !["0", "1"].includes(trimmed(row.direction_id))) {
      issues.push({ severity: "warning", code: "invalid_direction_id", row: index + 2 });
    }
  }

  const nameGroups = new Map();
  for (const row of stopRows) {
    const name = normalizedName(row.stop_name);
    if (name) nameGroups.set(name, [...(nameGroups.get(name) ?? []), trimmed(row.stop_id)]);
  }
  for (const [name, ids] of nameGroups) {
    if (ids.length > 1) collisions.push({ type: "duplicate_stop_name", normalizedName: name, sourceIds: ids.slice(0, 20), count: ids.length });
  }

  const calendarRanges = calendarRows
    .map((row) => ({ start: dateToIso(row.start_date), end: dateToIso(row.end_date) }))
    .filter(({ start, end }) => start && end);
  const exceptionDates = exceptionRows.map((row) => dateToIso(row.date)).filter(Boolean);
  const serviceDateValues = [...calendarRanges.flatMap(({ start, end }) => [start, end]), ...exceptionDates].sort();
  const infoRow = tableRows("feed_info.txt")[0] ?? {};
  const feedStart = dateToIso(infoRow.feed_start_date);
  const feedEnd = dateToIso(infoRow.feed_end_date);
  const today = now.toISOString().slice(0, 10);
  const currentWeekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getUTCDay()];
  const currentException = exceptionRows.filter((row) => dateToIso(row.date) === today);
  const servicesOperatingToday = new Set(currentException.filter((row) => trimmed(row.exception_type) === "1").map((row) => trimmed(row.service_id)));
  const canceledToday = new Set(currentException.filter((row) => trimmed(row.exception_type) === "2").map((row) => trimmed(row.service_id)));
  for (const row of calendarRows) {
    if (dateToIso(row.start_date) <= today && today <= dateToIso(row.end_date) && trimmed(row[currentWeekday]) === "1") {
      servicesOperatingToday.add(trimmed(row.service_id));
    }
  }
  for (const id of canceledToday) servicesOperatingToday.delete(id);
  const currentServiceIdSet = new Set(tripRows.map((row) => trimmed(row.service_id)));
  const dateCoverage = {
    serviceStart: serviceDateValues[0] ?? null,
    serviceEnd: serviceDateValues.at(-1) ?? null,
    feedStart,
    feedEnd,
    coversImportDate: servicesOperatingToday.size > 0 && [...servicesOperatingToday].some((id) => currentServiceIdSet.has(id)),
  };
  if (!calendarRows.length && !exceptionRows.length) {
    issues.push({ severity: "warning", code: "missing_service_calendar" });
  } else if (!dateCoverage.coversImportDate) {
    issues.push({ severity: "warning", code: "no_service_on_import_date", date: today });
  }

  for (const existing of existingFeeds) {
    for (const fileName of ["routes.txt", "stops.txt", "trips.txt"]) {
      const idField = primaryKeys[fileName];
      const existingIds = new Map();
      for (const row of existing.tables.get(fileName) ?? []) {
        const id = trimmed(row[idField]);
        if (id) existingIds.set(id, [...(existingIds.get(id) ?? []), row]);
      }
      for (const row of tableRows(fileName)) {
        const id = trimmed(row[idField]);
        if (!id || !existingIds.has(id)) continue;
        const others = existingIds.get(id);
        collisions.push({
          type: "cross_source_id_collision",
          file: fileName,
          sourceId: id,
          otherFeedId: existing.feedId,
          count: others.length,
          distinctRecords: new Set([...others.map((value) => JSON.stringify(value)), JSON.stringify(row)]).size,
        });
      }
    }
    const otherStops = new Map();
    for (const row of existing.tables.get("stops.txt") ?? []) {
      const name = normalizedName(row.stop_name);
      if (name) otherStops.set(name, [...(otherStops.get(name) ?? []), trimmed(row.stop_id)]);
    }
    for (const row of stopRows) {
      const name = normalizedName(row.stop_name);
      if (name && otherStops.has(name)) {
        collisions.push({ type: "cross_source_stop_name_collision", normalizedName: name, sourceId: trimmed(row.stop_id), otherFeedId: existing.feedId });
      }
    }
  }

  return {
    feedId,
    sourceName,
    tableStats,
    dateCoverage,
    issues,
    collisions,
    summary: {
      errorCount: issues.filter(({ severity }) => severity === "error").length,
      warningCount: issues.filter(({ severity }) => severity === "warning").length,
      collisionCount: collisions.length,
    },
  };
}

export function findStructuralErrors(report) {
  return report.issues.filter(({ severity }) => severity === "error");
}
