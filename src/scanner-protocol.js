export const scannerQrNote = "SAMPLE ONLY - NOT VALID FOR TRAVEL";

export function journeyTypeForRoundTrip(roundTrip) {
  return roundTrip ? "round_trip" : "one_way";
}

export function parseScannerCredential(value) {
  let credential;
  try {
    credential = JSON.parse(value);
  } catch {
    return null;
  }
  if (!credential || credential.demo !== true || credential.note !== scannerQrNote ||
      typeof credential.route !== "string") return null;

  if (typeof credential.ticket === "string" && !("pass" in credential)) {
    const allowedKeys = new Set(["demo", "ticket", "route", "seat", "note", "passenger"]);
    if (Object.keys(credential).some((key) => !allowedKeys.has(key)) ||
        typeof credential.seat !== "string" ||
        ("passenger" in credential && (typeof credential.passenger !== "string" || credential.passenger.length > 60))) {
      return null;
    }
    return { type: "ticket", id: credential.ticket, qr: credential };
  }

  if (typeof credential.pass === "string" && !("ticket" in credential)) {
    const allowedKeys = new Set(["demo", "pass", "route", "month", "weekdays", "journeyType", "note"]);
    if (Object.keys(credential).some((key) => !allowedKeys.has(key)) ||
        typeof credential.month !== "string" || typeof credential.weekdays !== "string" ||
        !["one_way", "round_trip"].includes(credential.journeyType)) {
      return null;
    }
    return { type: "pass", id: credential.pass, qr: credential };
  }
  return null;
}
