import test from "node:test";
import assert from "node:assert/strict";
import { getSubscriptionEstimate } from "../src/subscription.js";

test("uses the plan discount ladder and counts weekday occurrences in the month", () => {
  const estimate = getSubscriptionEstimate({
    fare: 20,
    month: "2026-02",
    weekdays: [1, 3, 5],
  });

  assert.deepEqual(estimate, {
    discount: 0.1,
    discountedFare: 18,
    weekdayOccurrences: 12,
    tripCount: 12,
    total: 216,
  });
});

test("doubles monthly trips and total for a return ride", () => {
  const estimate = getSubscriptionEstimate({
    fare: 45,
    month: "2026-12",
    weekdays: [2],
    roundTrip: true,
  });

  assert.deepEqual(estimate, {
    discount: 0,
    discountedFare: 45,
    weekdayOccurrences: 5,
    tripCount: 10,
    total: 450,
  });
});

test("rejects an empty or invalid weekday selection", () => {
  assert.throws(
    () => getSubscriptionEstimate({ fare: 20, month: "2026-02", weekdays: [] }),
    RangeError,
  );
});
