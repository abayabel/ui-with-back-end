import test from "node:test";
import assert from "node:assert/strict";
import {
  journeyTypeForRoundTrip,
  parseScannerCredential,
  scannerQrNote,
} from "../src/scanner-protocol.js";

test("parses existing ticket QR payloads with and without the checkout passenger field", () => {
  const historyQr = {
    demo: true,
    ticket: "DEMO-1234ABCD",
    route: "Bole to Piassa",
    seat: "12",
    note: scannerQrNote,
  };
  const checkoutQr = { ...historyQr, passenger: "Demo Passenger" };

  assert.equal(parseScannerCredential(JSON.stringify(historyQr)).type, "ticket");
  assert.equal(parseScannerCredential(JSON.stringify(checkoutQr)).id, historyQr.ticket);
});

test("parses the monthly pass QR and rejects non-demo or malformed credentials", () => {
  const passQr = {
    demo: true,
    pass: "PASS-1234ABCD",
    route: "Bole to Piassa",
    month: "2026-11",
    weekdays: "Mon, Wed, Fri",
    journeyType: "one_way",
    note: scannerQrNote,
  };

  assert.equal(parseScannerCredential(JSON.stringify(passQr)).type, "pass");
  assert.equal(parseScannerCredential(JSON.stringify({ ...passQr, journeyType: "round_trip" })).type, "pass");
  assert.equal(parseScannerCredential("not json"), null);
  assert.equal(parseScannerCredential(JSON.stringify({ ...passQr, demo: false })), null);
  assert.equal(parseScannerCredential(JSON.stringify({ ...passQr, journeyType: "return" })), null);
  const missingJourneyType = { ...passQr };
  delete missingJourneyType.journeyType;
  assert.equal(parseScannerCredential(JSON.stringify(missingJourneyType)), null);
});

test("maps the stored return-ride selection to the protocol journey type", () => {
  assert.equal(journeyTypeForRoundTrip(false), "one_way");
  assert.equal(journeyTypeForRoundTrip(true), "round_trip");
  assert.equal(journeyTypeForRoundTrip(undefined), "one_way");
});
