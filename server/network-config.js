const loopbackOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

function isPrivateIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

export function getNetworkConfig(env = process.env) {
  const lanMode = env.LAN_MODE === "true";
  let lanOrigin = null;
  if (lanMode) {
    if (!env.LAN_ORIGIN) {
      throw new Error("Set LAN_ORIGIN to the exact private IPv4 site origin, such as http://192.168.1.20:5173.");
    }
    let parsedOrigin;
    try {
      parsedOrigin = new URL(env.LAN_ORIGIN);
    } catch {
      throw new Error("LAN_ORIGIN must be an exact private IPv4 origin such as http://192.168.1.20:5173.");
    }
    if (parsedOrigin.protocol !== "http:" || parsedOrigin.port !== "5173" ||
        parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash ||
        parsedOrigin.username || parsedOrigin.password || !isPrivateIpv4(parsedOrigin.hostname) ||
        parsedOrigin.origin !== env.LAN_ORIGIN) {
      throw new Error("LAN_ORIGIN must be an exact private IPv4 origin such as http://192.168.1.20:5173.");
    }
    lanOrigin = parsedOrigin.origin;
  }
  return {
    lanMode,
    host: lanMode ? "0.0.0.0" : "127.0.0.1",
    lanOrigin,
    allowedOrigins: lanOrigin ? new Set([...loopbackOrigins, lanOrigin]) : loopbackOrigins,
  };
}
