import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Auto-restore vi.spyOn mocks after each test. Without this, a spy set in
    // one test (e.g. mocking usePrefersReducedMotion) silently leaks into
    // later tests in the same file that don't re-spy it themselves.
    restoreMocks: true,
  },
});
