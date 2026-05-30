import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@wasm": path.resolve(__dirname, "public/pkg"),
      "@deployments": path.resolve(__dirname, "../deployments"),
      buffer: "buffer",
      process: "process/browser",
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
