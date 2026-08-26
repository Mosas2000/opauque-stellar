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
    environment: "jsdom",
    testTimeout: 60_000,
    hookTimeout: 30_000,
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/__tests__/**",
        "src/lib/**/*.d.ts",
        "src/lib/**/index.ts",
      ],
    },
  },
});
