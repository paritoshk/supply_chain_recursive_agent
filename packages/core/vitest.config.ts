import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Offline by default: personas use the deterministic script; network clients are stubbed per test.
    env: { NODE_ENV: "test", PERSONA_MODE: "scripted", FAULTS: "" },
  },
});
