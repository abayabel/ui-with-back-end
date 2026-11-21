import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashScannerPassword } from "../server/scanner-auth.js";

const { Pool } = pg;

function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this provisioning command from an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (key) => {
      if (key === "\u0003") {
        finish(new Error("Provisioning cancelled."));
      } else if (key === "\r" || key === "\n") {
        finish();
      } else if (key === "\u007f" || key === "\u0008") {
        value = [...value].slice(0, -1).join("");
      } else {
        value += key;
      }
    };
    process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = process.argv[2]?.trim().toLowerCase();
  if (!username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("Usage: npm run scanner:user:add -- <username> (3-64 letters, numbers, '.', '_' or '-').");
  }
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before provisioning a conductor account.");
  const password = await readHidden("New conductor password (12+ characters): ");
  const confirmation = await readHidden("Confirm password: ");
  if (Buffer.byteLength(password, "utf8") < 12 || Buffer.byteLength(password, "utf8") > 256) {
    throw new Error("Password must be between 12 and 256 UTF-8 bytes.");
  }
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const passwordHash = await hashScannerPassword(password);
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO scanner_users (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'conductor')
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = true,
         updated_at = now()`,
      [userId, username, passwordHash],
    );
    console.info(`Conductor account provisioned: ${username}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
