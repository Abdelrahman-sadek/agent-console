import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is web/ (the UI).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
