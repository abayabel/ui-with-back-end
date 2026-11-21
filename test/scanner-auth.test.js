import test from "node:test";
import assert from "node:assert/strict";
import {
  issueConductorToken,
  scannerTokenTtlSeconds,
  verifyConductorToken,
  verifyScannerPassword,
  hashScannerPassword,
} from "../server/scanner-auth.js";

test("hashes conductor passwords and verifies only the matching password", async () => {
  const hash = await hashScannerPassword("correct horse battery staple");

  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(hash, "correct horse battery staple");
  assert.equal(await verifyScannerPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyScannerPassword("incorrect password", hash), false);
  assert.equal(await verifyScannerPassword("anything", "invalid"), false);
});

test("issues short-lived conductor tokens and rejects expired or invalid-role tokens", () => {
  const now = 1_700_000_000;
  const secret = "test-only-secret-that-is-long-enough-123456";
  const token = issueConductorToken({ id: "user-1", username: "conductor1" }, secret, now);
  const claims = verifyConductorToken(token, secret, now);

  assert.equal(claims.role, "conductor");
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.exp - claims.iat, scannerTokenTtlSeconds);
  assert.equal(verifyConductorToken(token, secret, now + scannerTokenTtlSeconds), null);
  assert.equal(verifyConductorToken(token, "a-different-secret-long-enough-123456", now), null);
});
