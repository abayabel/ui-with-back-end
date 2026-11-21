# Ride Addis passenger preview

A runnable passenger-side preview for the Addis Ababa bus ticketing plan. Sample routes and ticket/pass records use a local PostgreSQL database. Optional GTFS archives can be imported as separate, attributed timetable sources; they do not replace sample routes or provide booking prices.

## Run locally

1. Install Node.js 18 or newer and have PostgreSQL running as user `postgres` on port `5432`. If needed, create the database with `CREATE DATABASE "city bus";`.
2. Copy `.env.example` to `.env`, set `DATABASE_URL` to the local database credentials, replace `JWT_SECRET` with a random secret of at least 32 characters, and set `SCANNER_SIGNING_PRIVATE_KEY_BASE64` to a generated Ed25519 private key. Generate one with `node -e "const { generateKeyPairSync } = require('node:crypto'); const { privateKey } = generateKeyPairSync('ed25519'); console.log(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))"`; keep the key only in `.env`.
3. Run `npm install`, then `npm run dev` to start the API and Vite together.
4. Open `http://127.0.0.1:5173`.

The scanner API starts without any conductor accounts. After the first API startup applies migrations, provision an account from an interactive terminal with `npm run scanner:user:add -- <username>`. The command prompts twice for a hidden password (12-256 UTF-8 bytes) and stores only a salted scrypt hash; it creates no default credentials.

For the optional Docker Compose database, set `POSTGRES_PASSWORD` to a local-only password and point `DATABASE_URL` at `localhost:5433/city%20bus` before starting the API. Then use `npm run db:up` and `npm run db:down` to start/stop Compose without removing its data volume.

On API startup, migrations in `db/migrations` are applied and the stops, ordered route-stop associations, and sample routes in `db/seed-routes.json` are inserted or updated. The API listens on port `5000` by default. Run `npm run build` to create a production build; `npm start` serves that build and the API on the port in `.env`.

## Import GTFS timetable feeds

The two supplied archives were inspected before import:

| Feed | Routes | Stops | Trips | Stop times | Calendar coverage |
| --- | ---: | ---: | ---: | ---: | --- |
| Anbessa City Bus Service Enterprise | 87 | 592 rows | 134 | 2,202 | 2019-01-01–2021-01-01 |
| AddisMap / DT4A | 194 | 1,350 | 387 | 5,010 | 2019-12-01–2099-12-31 |

Both feeds have consistent trip/route/stop-time references. The Anbessa archive has 20 repeated stop IDs and repeated stop names; these source rows are retained and ambiguous stop references are excluded from the web timetable. The feeds share 87 trip IDs. Those records remain isolated under their source feed IDs and are reported as collisions; they are never joined or deduplicated across sources. The second feed supplies frequency windows rather than exact departures, so the website displays those ranges and does not invent a departure/arrival time or fare.

Run a report-only validation first (PowerShell example; use the exact ZIP path you have):

```powershell
npm run gtfs:import -- --source-id anbessa-enterprise --source-name "Anbessa City Bus" --file "C:\path\to\AnbessaCityBusServiceEnterprise_GTFS.zip" --dry-run
npm run gtfs:import -- --source-id addismap-2026 --source-name "AddisMap + DT4A" --file "C:\path\to\et-addisababa-bus_2026.zip" --dry-run
```

Omit `--dry-run` to import. `--source-id` is a stable, source-scoped namespace; reuse it to idempotently replace that feed's imported snapshot. The importer validates CSV structure, required fields, IDs, references, service dates, times, and calendar coverage, and reports duplicate IDs, same-name stops, and cross-source collisions. Fatal structural errors abort without replacing an existing import; reported source collisions are preserved, not silently merged. Raw GTFS rows and normalized routes, stops, trips, stop times, calendars, exceptions, and frequency records retain their feed ID, original source ID, file, row number, and source data. ZIPs are read in place and are not copied into the repository.

The API exposes date-specific schedules at `GET /api/gtfs/routes?date=YYYY-MM-DD`. The route search page renders currently active imported schedules separately from the sample routes. Imported routes are timetable-only and cannot be booked or used for demo passes because the feeds do not specify a fare. Historical/expired service is not presented as current service; its coverage and validation warnings remain available in the import report.

## Preview on a phone over the same Wi-Fi

The default remains loopback-only. For a temporary same-network preview, find the PC's Wi-Fi IPv4 address with `ipconfig` in PowerShell (look under the active Wi-Fi adapter; for example, `192.168.1.20`). In `.env`, set:

```dotenv
LAN_MODE=true
LAN_ORIGIN=http://192.168.1.20:5173
```

Replace the sample address with the PC's actual private IPv4 address. `LAN_ORIGIN` must exactly match the phone's site origin and use port `5173`; the server rejects missing, public, or mismatched origins. Then run `npm run dev` on the PC and open `http://192.168.1.20:5173` on a phone connected to the same Wi-Fi. Keep the PC and phone on that local network; this is not public hosting.

In this opt-in mode Vite and the authenticated API bind to the network interfaces. The browser uses Vite's `/api` proxy; direct browser API requests accept only the configured site origin (plus the local loopback preview origins). Scanner manifest and scan-sync authentication remains required. PostgreSQL is not exposed: the optional Compose database publishes only on `127.0.0.1`, and the API connects to it from the PC. No router forwarding or firewall rules are changed automatically. If Windows Firewall prompts, allow access only on the private network if you choose to; turn LAN mode off (`LAN_MODE=false`) when done.

## Preview flow

Search a database-seeded sample route and date, choose a departure, select a seat, hold it for five minutes, and enter a passenger name to save a demo e-ticket. Routes and subscriptions use the same PostgreSQL stops and ordered route-stop records. Tickets and monthly passes are stored in PostgreSQL and appear under **My tickets**; a ticket's demo use action persists its used status. Both ticket types display a sample QR code.

Use **My balance** to add a mock top-up with a selected amount and demo payment label. Use **Monthly pass** to select a sample route, month, weekdays, and one-way or round-trip travel. The estimate counts weekday occurrences in that calendar month and applies the plan's placeholder discount table: 0% for one chosen day per week, increasing by 5 percentage points per additional day up to 30% for seven days. A demo pass can be checked out from the in-page demo balance.

Purchases appear under **My tickets**. Open a one-time ticket to view its demo QR and use the “Demo scan / mark as used” action to expire it. Open a monthly pass to view its route, weekdays, demo amount, expiry at the end of its selected month, and its own demo QR.

Routes, tickets, and monthly subscriptions are stored in the local PostgreSQL database. The starting wallet balance and top-ups remain in-page demo state and reset when the page is refreshed.

**This is a local preview only.** Checkout and top-ups do not process payments, demo subscriptions do not activate transit service, and neither QR code validates travel. OTP, passenger accounts, production payment services, live bus tracking, NFC, and SMS are not implemented or connected. `AI_SERVICE_URL` is configuration only; no AI verification service is called. Scanner conductor login uses the environment-provided `JWT_SECRET`; no secret or database credential is sent to the mobile client.

## Offline scanner API contract

These endpoints support an offline-scanner prototype against the local demo database. A mobile client must not contain database credentials. The API binds to `127.0.0.1` by default; opt-in same-Wi-Fi access is described above. Do not use it for real transit validation. The mobile app must pin the Ed25519 public key from trusted configuration. `GET /api/scanner/keys/:keyId` is unauthenticated for local key provisioning only, not a way to trust an otherwise unverified key.

Provision a conductor account as described above, then log in with `POST /api/scanner/auth/login`:

```json
{"username":"conductor1","password":"<provisioned password>"}
```

```json
{"accessToken":"<short-lived JWT>","tokenType":"Bearer","expiresAt":"2026-11-14T11:31:00.000Z","role":"conductor"}
```

The response's `expiresAt` is the JWT expiry as an RFC3339 UTC timestamp. The JWT is HS256, expires after 15 minutes, and carries the `conductor` role. Send it as `Authorization: Bearer <accessToken>` to both `GET /api/scanner/trips/:tripId/manifest` and `POST /api/scanner/scans/sync`; requests without a valid conductor token receive HTTP 401. Login failures return the same HTTP 401 message for unknown, inactive, or incorrect credentials, and login is rate-limited to five attempts per source IP per 15 minutes. There are no default/shared accounts. Password hashes use scrypt, and only the server reads `JWT_SECRET`.

The current QR payloads are raw JSON strings:

```json
{"demo":true,"ticket":"DEMO-…","route":"Bole to Piassa","seat":"12","note":"SAMPLE ONLY - NOT VALID FOR TRAVEL"}
```

```json
{"demo":true,"pass":"PASS-…","route":"Bole to Piassa","month":"YYYY-MM","weekdays":"Mon, Wed, Fri","journeyType":"one_way","note":"SAMPLE ONLY - NOT VALID FOR TRAVEL"}
```

The immediate post-checkout ticket QR may additionally contain `"passenger":"…"`; scanner clients should ignore that optional field and the server does not include passenger names in manifests.

Fetch a date-specific trip manifest with `GET /api/scanner/trips/:tripId/manifest?date=YYYY-MM-DD`; `date` defaults to the current date in `Africa/Addis_Ababa` and cannot be in the past. The response is `{"keyId":"ride-addis-scanner-v1","algorithm":"Ed25519","payload":"<base64url>","signature":"<base64url>"}`. Base64url-decode `payload` to the exact compact UTF-8 JSON bytes and verify `signature` over those bytes with Ed25519 before parsing them. The decoded payload has this shape:

```json
{
  "demo": true,
  "schemaVersion": 1,
  "tripId": "bole-piassa-0815",
  "routeId": "bole-piassa",
  "travelDate": "2026-11-14",
  "issuedAt": "2026-11-14T08:00:00.000Z",
  "expiresAt": "2026-11-14T20:59:59.999Z",
  "stops": [{"id":"bole","name":"Bole","order":0}],
  "credentials": [
    {"type":"ticket","id":"DEMO-…","qr":{"demo":true,"ticket":"DEMO-…","route":"Bole to Piassa","seat":"12","note":"SAMPLE ONLY - NOT VALID FOR TRAVEL"}},
    {"type":"pass","id":"PASS-…","journeyType":"round_trip","qr":{"demo":true,"pass":"PASS-…","route":"Bole to Piassa","month":"2026-11","weekdays":"Mon, Wed, Fri","journeyType":"round_trip","note":"SAMPLE ONLY - NOT VALID FOR TRAVEL"}}
  ]
}
```

Only valid one-time tickets for the requested trip/date and monthly passes eligible for that route, month, and weekday are included. A pass has `journeyType: "one_way" | "round_trip"` both on its signed manifest credential and inside its QR object. This value comes from the subscription's stored return-ride selection; existing subscriptions with no return ride use the database default `round_trip = false` and are `one_way`. `GET /api/scanner/keys/:keyId` returns `{"keyId":"…","algorithm":"Ed25519","publicKey":"<base64url DER-SPKI>"}`. The signing key comes from `SCANNER_SIGNING_PRIVATE_KEY_BASE64` and is never sent to the client.

For the current local Android preview build, pin this Ed25519 public key in trusted app configuration (do not trust a key merely because it was fetched from the API):

```text
keyId: ride-addis-scanner-v1
publicKey (base64url DER-SPKI): MCowBQYDK2VwAyEAZzgptTtUZAUzZ-wKWB-2E7G623oa_uf5bEXTTzTx7SQ
```

This pin corresponds to the active local `.env` signing key. Keep that private key out of the Android app and tracked files; if the server signing key is rotated or regenerated, update the Android pin at the same time.

Queue scans with `POST /api/scanner/scans/sync`:

```json
{
  "scans": [{
    "scanId": "c0a80123-0000-4000-8000-000000000001",
    "credential": "{\"demo\":true,\"ticket\":\"DEMO-…\",\"route\":\"Bole to Piassa\",\"seat\":\"12\",\"note\":\"SAMPLE ONLY - NOT VALID FOR TRAVEL\"}",
    "tripId": "bole-piassa-0815",
    "stopId": "bole",
    "action": "board",
    "scannedAt": "2026-11-14T11:00:00+03:00",
    "deviceId": "conductor-device-1"
  }]
}
```

The response contains one result per input event: `{"results":[{"scanId":"…","status":"accepted|rejected|conflict","code":"…","credentialType":"ticket|pass|null","credentialId":"…|null","replayed":false}]}`. A repeated `scanId` with the same event returns its stored result with `replayed:true`; reuse with different event data returns `conflict/scan_id_reused`. Other rejection codes include `invalid_credential`, `unsupported_action`, `unknown_trip`, `wrong_stop`, `wrong_route`, `credential_not_found`, `ticket_mismatch`, `ticket_wrong_date`, `pass_mismatch`, and `pass_not_eligible`. Conflicts include `ticket_already_used`, `pass_already_scanned_at_stop`, and `pass_daily_limit`. Only `board` scans are supported. An accepted one-time ticket is marked used in PostgreSQL. Pass sync verifies the QR's `journeyType` against the stored subscription, then enforces limits using that database value: one accepted boarding per Addis local date for `one_way`, or up to two distinct `(tripId, stopId)` pairs for `round_trip`; a repeated pair conflicts. Never use the QR's direction field as authority. Offline scans remain provisional on the device until sync; online sync is required to reconcile cross-device duplicates.

Run `npm test` for the subscription-pricing, ticket/pass-expiry, QR credential parsing, password-hash, and token checks. PostgreSQL must be running before the app can load its routes and saved records; Docker Desktop is needed only for the optional Compose database.
