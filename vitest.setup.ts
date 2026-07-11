import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { TextDecoder, TextEncoder } from "node:util";

Object.assign(globalThis, {
  TextDecoder,
  TextEncoder,
});

globalThis.fetch = vi.fn<typeof fetch>(
  async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
);
