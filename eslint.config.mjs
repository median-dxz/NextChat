import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import unusedImports from "eslint-plugin-unused-imports";

const compilerDiagnostics = [
  "component-hook-factories",
  "config",
  "error-boundaries",
  "gating",
  "globals",
  "immutability",
  "incompatible-library",
  "preserve-manual-memoization",
  "purity",
  "refs",
  "set-state-in-effect",
  "set-state-in-render",
  "static-components",
  "unsupported-syntax",
  "use-memo",
];

export default defineConfig([
  ...nextVitals,
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "unused-imports/no-unused-imports": "warn",
      ...Object.fromEntries(
        compilerDiagnostics.map((rule) => [`react-hooks/${rule}`, "warn"]),
      ),
    },
  },
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "src-tauri/target/**",
    "next-env.d.ts",
    "public/serviceWorker.js",
    "app/mcp/mcp_config.json",
    "app/mcp/mcp_config.default.json",
  ]),
]);
