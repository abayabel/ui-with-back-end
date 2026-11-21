import test from "node:test";
import assert from "node:assert/strict";
import { getNetworkConfig } from "../server/network-config.js";

test("keeps API and Vite loopback-only unless LAN mode is explicitly enabled", () => {
  const config = getNetworkConfig({});

  assert.equal(config.lanMode, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.lanOrigin, null);
  assert.equal(config.allowedOrigins.has("http://127.0.0.1:5173"), true);
  assert.equal(config.allowedOrigins.has("https://example.com"), false);
});

test("enables LAN binds only with an exact RFC1918 site origin", () => {
  const config = getNetworkConfig({
    LAN_MODE: "true",
    LAN_ORIGIN: "http://192.168.1.20:5173",
  });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.lanOrigin, "http://192.168.1.20:5173");
  assert.equal(config.allowedOrigins.has(config.lanOrigin), true);
  assert.throws(() => getNetworkConfig({ LAN_MODE: "true" }), /LAN_ORIGIN/);
  assert.throws(() => getNetworkConfig({
    LAN_MODE: "true",
    LAN_ORIGIN: "https://192.168.1.20:5173",
  }), /private IPv4 origin/);
  assert.throws(() => getNetworkConfig({
    LAN_MODE: "true",
    LAN_ORIGIN: "http://example.com:5173",
  }), /private IPv4 origin/);
});
