import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGtfsFeed, findStructuralErrors, parseGtfsCsv } from "../server/gtfs-import.js";
import { buildGtfsRouteView } from "../server/gtfs-schedules.js";

test("parses quoted GTFS CSV fields, escaped quotes, and embedded newlines", () => {
  const parsed = parseGtfsCsv('\uFEFFid,name,notes\r\n1,"Bole, East","a ""quoted"" note"\r\n2,"Line\nTwo",ok\r\n');

  assert.deepEqual(parsed.headers, ["id", "name", "notes"]);
  assert.deepEqual(parsed.rows, [
    { id: "1", name: "Bole, East", notes: 'a "quoted" note' },
    { id: "2", name: "Line\nTwo", notes: "ok" },
  ]);
  assert.throws(() => parseGtfsCsv('id,name\n1,"unfinished'), /unterminated quoted/);
});

test("analyzes expired service coverage and reports duplicate and cross-source identifiers", () => {
  const tables = new Map([
    ["agency.txt", { headers: ["agency_id", "agency_name", "agency_url", "agency_timezone"], rows: [{ agency_id: "a", agency_name: "Agency", agency_url: "https://example.test", agency_timezone: "Africa/Addis_Ababa" }] }],
    ["routes.txt", { headers: ["route_id", "route_short_name", "route_type"], rows: [{ route_id: "r", route_short_name: "R", route_type: "3" }] }],
    ["stops.txt", { headers: ["stop_id", "stop_name"], rows: [{ stop_id: "s", stop_name: "Stop" }, { stop_id: "s", stop_name: "Different Stop" }] }],
    ["trips.txt", { headers: ["route_id", "service_id", "trip_id"], rows: [{ route_id: "r", service_id: "weekday", trip_id: "t" }] }],
    ["stop_times.txt", { headers: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], rows: [] }],
    ["calendar.txt", { headers: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], rows: [{ service_id: "weekday", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20190101", end_date: "20210101" }] }],
  ]);
  const report = analyzeGtfsFeed({
    feedId: "new-feed",
    sourceName: "New feed",
    tables,
    existingFeeds: [{
      feedId: "old-feed",
      tables: new Map([["trips.txt", [{ trip_id: "t" }]], ["routes.txt", []], ["stops.txt", []]]),
    }],
    now: new Date("2026-11-19T12:00:00.000Z"),
  });

  assert.deepEqual(findStructuralErrors(report), []);
  assert.equal(report.dateCoverage.serviceEnd, "2021-01-01");
  assert.equal(report.dateCoverage.coversImportDate, false);
  assert.ok(report.collisions.some(({ type, sourceId }) => type === "duplicate_source_id" && sourceId === "s"));
  assert.ok(report.collisions.some(({ type, sourceId, otherFeedId }) =>
    type === "cross_source_id_collision" && sourceId === "t" && otherFeedId === "old-feed"));
  assert.ok(report.issues.some(({ code }) => code === "no_service_on_import_date"));
});

test("keeps same-ID routes from different feeds separate and does not invent frequency departures", () => {
  const feeds = [
    { feed_id: "feed-a", source_name: "Feed A", content_sha256: "a".repeat(64), validation_report: {} },
    { feed_id: "feed-b", source_name: "Feed B", content_sha256: "b".repeat(64), validation_report: {} },
  ];
  const routes = feeds.map(({ feed_id }) => ({ feed_id, source_route_id: "r", short_name: "1", long_name: "Route 1", route_type: 3 }));
  const stops = feeds.flatMap(({ feed_id }) => [
    { feed_id, source_stop_id: "a", stop_name: "Alpha", source_row: 2 },
    { feed_id, source_stop_id: "b", stop_name: "Beta", source_row: 3 },
  ]);
  const trips = feeds.map(({ feed_id }) => ({
    feed_id, source_trip_id: "same-trip", source_route_id: "r", service_id: "s",
    headsign: "Beta", short_name: null, direction_id: 0, source_row: 2,
  }));
  const stopTimes = feeds.flatMap(({ feed_id }) => [
    { feed_id, source_trip_id: "same-trip", source_stop_id: "a", stop_sequence: 1, departure_time: "08:00:00", arrival_time: "08:00:00", source_row: 2 },
    { feed_id, source_trip_id: "same-trip", source_stop_id: "b", stop_sequence: 2, departure_time: "08:30:00", arrival_time: "08:30:00", source_row: 3 },
  ]);
  const calendars = feeds.map(({ feed_id }) => ({
    feed_id, service_id: "s", monday: true, tuesday: true, wednesday: true, thursday: true,
    friday: true, saturday: true, sunday: true, start_date: "2026-01-01", end_date: "2026-12-31",
  }));
  const result = buildGtfsRouteView({
    date: "2026-11-19", feeds, routes, stops, trips, stopTimes, calendars, exceptions: [],
    frequencies: feeds.map(({ feed_id }) => ({
      feed_id, source_trip_id: "same-trip", start_time: "08:00:00", end_time: "09:00:00",
      headway_seconds: 600, exact_times: 0, source_row: 2,
    })),
  });

  assert.equal(result.length, 2);
  assert.notEqual(result[0].id, result[1].id);
  assert.ok(result.every(({ bookable }) => bookable === false));
  assert.ok(result.every(({ trips: [trip] }) => trip.departure === null && trip.arrival === null));
  assert.ok(result.every(({ trips: [trip] }) => trip.frequencies[0].headwaySeconds === 600));
});
