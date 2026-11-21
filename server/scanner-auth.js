import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scrypt = promisify(scryptCallback);
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const JWT_ISSUER = "ride-addis-api";
const JWT_AUDIENCE = "ride-addis-scanner";
export const scannerTokenTtlSeconds = 15 * 60;

export async function hashScannerPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyScannerPassword(password, encodedHash) {
  const [algorithm, cost, blockSize, parallelism, saltText, keyText, extra] = encodedHash?.split("$") ?? [];
  const salt = Buffer.from(saltText ?? "", "base64url");
  const expectedKey = Buffer.from(keyText ?? "", "base64url");
  if (algorithm !== "scrypt" || Number(cost) !== SCRYPT_COST ||
      Number(blockSize) !== SCRYPT_BLOCK_SIZE || Number(parallelism) !== SCRYPT_PARALLELISM ||
      extra !== undefined || salt.length !== 16 || expectedKey.length !== SCRYPT_KEY_LENGTH) {
    return false;
  }
  const actualKey = await scrypt(password, salt, expectedKey.length, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return timingSafeEqual(actualKey, expectedKey);
}

export function issueConductorToken(user, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  return jwt.sign({
    username: user.username,
    role: "conductor",
    iat: nowSeconds,
  }, secret, {
    algorithm: "HS256",
    subject: user.id,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: scannerTokenTtlSeconds,
  });
}

export function verifyConductorToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const claims = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTimestamp: nowSeconds,
    });
    if (typeof claims === "string" || claims.role !== "conductor" ||
        typeof claims.sub !== "string" || typeof claims.username !== "string") {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
