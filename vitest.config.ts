import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      nanoid: fileURLToPath(
        new URL("./test/mocks/nanoid.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    hookTimeout: 30_000,
    include: ["test/**/*.{test,spec}.{js,ts,jsx,tsx}"],
    exclude: [".next/**", "node_modules/**"],
    coverage: {
      provider: "v8",
    },
  },
});
