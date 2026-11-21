import test from "node:test";
import assert from "node:assert/strict";
import { getMonthEndDate, getMonthlyPassStatus } from "../src/ticket-status.js";

test("monthly pass stays active through its selected month and expires afterward", () => {
  assert.equal(getMonthlyPassStatus("2026-11", "2026-10"), "upcoming");
  assert.equal(getMonthlyPassStatus("2026-11", "2026-11"), "active");
  assert.equal(getMonthlyPassStatus("2026-11", "2026-12"), "expired");
});

test("pass expiry date is the last calendar day, including leap February", () => {
  assert.equal(getMonthEndDate("2026-11"), "2026-11-30");
  assert.equal(getMonthEndDate("2028-02"), "2028-02-29");
});
