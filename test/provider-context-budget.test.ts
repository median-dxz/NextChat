import { afterEach, describe, expect, test, vi } from "vitest";

import { GeminiProApi } from "../app/client/platforms/google";

const originalFetch = window.fetch;

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("provider context adaptation", () => {
  test("maps assistant history to Gemini model and normalizes adjacent roles", async () => {
    let payload: any;
    window.fetch = vi.fn(async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const messages = [
      { role: "system" as const, content: "memory" },
      { role: "user" as const, content: "pinned" },
      { role: "assistant" as const, content: "summary" },
      { role: "user" as const, content: "current" },
    ];

    await new GeminiProApi().chat({
      messages,
      config: {
        model: "gemini-2.0-flash",
        temperature: 0.5,
        top_p: 1,
        max_tokens: 128,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false,
      },
      onFinish() {},
    });

    expect(payload.generationConfig.maxOutputTokens).toBe(128);
    expect(payload.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "memory" }, { text: "pinned" }],
      },
      { role: "model", parts: [{ text: "summary" }] },
      { role: "user", parts: [{ text: "current" }] },
    ]);
  });
});
