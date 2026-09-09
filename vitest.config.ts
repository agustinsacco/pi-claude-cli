import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Hermetic environment — see tests/setup-env.ts. Without it the suite
    // fails when run from a session driven by this extension itself.
    setupFiles: ["tests/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "index.ts"],
      exclude: ["src/mcp-schema-server.cjs"],
      thresholds: {
        lines: 92,
        functions: 92,
        branches: 88,
        statements: 92,
      },
    },
  },
});
