import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    environment: "node",
    // Native SQLite bindings are more stable in worker threads than forked
    // child processes across the Node versions used by CI.
    pool: "threads",
  },
});
