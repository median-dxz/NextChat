import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL(".", import.meta.url)),
      },
      {
        find: "nanoid",
        replacement: fileURLToPath(new URL("./test/mocks/nanoid.ts", import.meta.url)),
      },
      {
        find: /^.*\/icons\/[^/]+\.svg$/,
        replacement: fileURLToPath(new URL("./test/mocks/icon.ts", import.meta.url)),
      },
    ],
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
