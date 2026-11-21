import { defineConfig, loadEnv } from "vite";
import { getNetworkConfig } from "./server/network-config.js";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const networkConfig = getNetworkConfig(env);
  return {
    server: {
      host: networkConfig.host,
      proxy: {
        "/api": "http://127.0.0.1:5000",
      },
    },
  };
});
