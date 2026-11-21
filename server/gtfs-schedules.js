function isoDate(value) {
  const date = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

function isActiveService(serviceId, date, calendars, exceptions) {
  const matchingExceptions = exceptions.filter((row) => row.service_id === serviceId && isoDate(row.service_date) === date);
  const exceptionTypes = new Set(matchingExceptions.map((row) => Number(row.exception_type)));
  if (exceptionTypes.size > 1 || [...exceptionTypes].some((type) => type !== 1 && type !== 2)) return false;
  if (exceptionTypes.size === 1) return exceptionTypes.has(1);

  const matchingCalendars = calendars.filter((row) => row.service_id === serviceId);
  if (matchingCalendars.length !== 1) return false;
  const calendar = matchingCalendars[0];
  const start = isoDate(calendar.start_date);
  const end = isoDate(calendar.end_date);
  if (!start || !end || date < start || date > end) return false;
  const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
    new Date(`${date}T00:00:00.000Z`).getUTCDay()
  ];
  return calendar[day] === true;
}

function uniqueRowsBySourceId(rows, sourceIdKey) {
  const groups = new Map();
  for (const row of rows) {
    groups.set(row[sourceIdKey], [...(groups.get(row[sourceIdKey]) ?? []), row]);
  }
  return new Map([...groups].filter(([, values]) => values.length === 1).map(([id, values]) => [id, values[0]]));
}

export function buildGtfsRouteView({ date, feeds, routes, stops, trips, stopTimes, calendars, exceptions, frequencies }) {
  const travelDate = isoDate(date);
  if (!travelDate) throw new Error("date must be a valid YYYY-MM-DD date.");
  const feedById = new Map(feeds.map((feed) => [feed.feed_id, feed]));
  const routesByFeed = new Map();
  const stopsByFeed = new Map();
  const tripsByFeed = new Map();
  const timesByTrip = new Map();
  const calendarsByFeed = new Map();
  const exceptionsByFeed = new Map();
  const frequenciesByTrip = new Map();

  for (const feedId of feedById.keys()) {
    const feedRoutes = routes.filter((row) => row.feed_id === feedId);
    routesByFeed.set(feedId, uniqueRowsBySourceId(feedRoutes, "source_route_id"));
    const feedStops = stops.filter((row) => row.feed_id === feedId);
    stopsByFeed.set(feedId, uniqueRowsBySourceId(feedStops, "source_stop_id"));
    const feedTrips = trips.filter((row) => row.feed_id === feedId);
    tripsByFeed.set(feedId, uniqueRowsBySourceId(feedTrips, "source_trip_id"));
    calendarsByFeed.set(feedId, calendars.filter((row) => row.feed_id === feedId));
    exceptionsByFeed.set(feedId, exceptions.filter((row) => row.feed_id === feedId));
  }
  for (const row of stopTimes) {
    const key = `${row.feed_id}\u0000${row.source_trip_id}`;
    timesByTrip.set(key, [...(timesByTrip.get(key) ?? []), row]);
  }
  for (const row of frequencies) {
    const key = `${row.feed_id}\u0000${row.source_trip_id}`;
    frequenciesByTrip.set(key, [...(frequenciesByTrip.get(key) ?? []), row]);
  }

  const routesByPattern = new Map();
  for (const [feedId, sourceTrips] of tripsByFeed) {
    const serviceCalendars = calendarsByFeed.get(feedId);
    const serviceExceptions = exceptionsByFeed.get(feedId);
    const sourceRoutes = routesByFeed.get(feedId);
    const sourceStops = stopsByFeed.get(feedId);
    for (const trip of sourceTrips.values()) {
      if (!sourceRoutes.has(trip.source_route_id) ||
          !isActiveService(trip.service_id, travelDate, serviceCalendars, serviceExceptions)) continue;
      const sourceTimes = (timesByTrip.get(`${feedId}\u0000${trip.source_trip_id}`) ?? [])
        .slice()
        .sort((left, right) => left.stop_sequence - right.stop_sequence);
      if (sourceTimes.length < 2) continue;
      const sequences = sourceTimes.map(({ stop_sequence }) => Number(stop_sequence));
      if (new Set(sequences).size !== sequences.length) continue;
      const itinerary = sourceTimes.map((time) => {
        const stop = sourceStops.get(time.source_stop_id);
        return stop ? {
          id: stop.source_stop_id,
          name: stop.stop_name,
          sourceRow: stop.source_row,
          arrival: time.arrival_time,
          departure: time.departure_time,
          sequence: time.stop_sequence,
          sourceRowTime: time.source_row,
        } : null;
      });
      if (itinerary.some((stop) => !stop)) continue;

      const firstStop = itinerary[0];
      const lastStop = itinerary.at(-1);
      if (!firstStop.name || !lastStop.name) continue;
      const route = sourceRoutes.get(trip.source_route_id);
      const patternKey = [feedId, trip.source_route_id, firstStop.id, lastStop.id].join("\u0000");
      const feed = feedById.get(feedId);
      const grouped = routesByPattern.get(patternKey) ?? {
        id: `gtfs:${encodeURIComponent(feedId)}:${encodeURIComponent(trip.source_route_id)}:${encodeURIComponent(firstStop.id)}:${encodeURIComponent(lastStop.id)}`,
        sourceType: "gtfs",
        bookable: false,
        sourceFeedId: feedId,
        sourceName: feed.source_name,
        sourceHash: feed.content_sha256,
        routeId: route.source_route_id,
        routeShortName: route.short_name,
        routeLongName: route.long_name,
        routeType: route.route_type,
        from: firstStop.name,
        to: lastStop.name,
        fromStopId: firstStop.id,
        toStopId: lastStop.id,
        stops: itinerary.map(({ id, name, sequence, sourceRow }) => ({ id, name, sequence, sourceRow })),
        date: travelDate,
        dateCoverage: feed.validation_report?.dateCoverage ?? null,
        trips: [],
      };
      const frequencyRows = frequenciesByTrip.get(`${feedId}\u0000${trip.source_trip_id}`) ?? [];
      grouped.trips.push({
        id: trip.source_trip_id,
        sourceRow: trip.source_row,
        serviceId: trip.service_id,
        headsign: trip.headsign,
        shortName: trip.short_name,
        directionId: trip.direction_id,
        departure: frequencyRows.length ? null : firstStop.departure,
        arrival: frequencyRows.length ? null : lastStop.arrival,
        frequencies: frequencyRows.map((frequency) => ({
          startTime: frequency.start_time,
          endTime: frequency.end_time,
          headwaySeconds: frequency.headway_seconds,
          exactTimes: frequency.exact_times,
          sourceRow: frequency.source_row,
        })),
        stops: itinerary.map(({ id, name, sequence, sourceRow, sourceRowTime }) => ({
          id,
          name,
          sequence,
          sourceRow,
          sourceRowTime,
        })),
      });
      routesByPattern.set(patternKey, grouped);
    }
  }

  return [...routesByPattern.values()]
    .map((route) => ({ ...route, trips: route.trips.sort((left, right) =>
      (left.departure ?? left.frequencies[0]?.startTime ?? "").localeCompare(
        right.departure ?? right.frequencies[0]?.startTime ?? "",
      )) }))
    .sort((left, right) =>
      left.sourceFeedId.localeCompare(right.sourceFeedId) ||
      left.routeId.localeCompare(right.routeId) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to));
}
