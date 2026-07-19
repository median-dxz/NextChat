import { afterEach, describe, expect, test, vi } from "vitest";

import { ChatGPTApi } from "../app/client/platforms/openai";
import { GeminiProApi } from "../app/client/platforms/google";
import { getProviderContextAdapter } from "../app/client/provider-context";
import { ServiceProvider } from "../app/constant";

const originalFetch = window.fetch;

afterEach(() => {
  window.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("provider context adaptation", () => {
  test("uses the request-specific output limit for OpenAI vision models", async () => {
    let payload: any;
    window.fetch = vi.fn(async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await new ChatGPTApi().chat({
      messages: [{ role: "user", content: "hello" }],
      config: {
        model: "gpt-4o-mini",
        providerName: ServiceProvider.OpenAI,
        max_tokens: 128,
        stream: false,
      },
      onFinish() {},
    });

    expect(payload.max_tokens).toBe(128);
  });

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

    const messages = getProviderContextAdapter(ServiceProvider.Google).materialize(
      [
        {
          kind: "fixed",
          message: { role: "system", content: "memory" },
        },
        {
          kind: "fixed",
          message: { role: "user", content: "pinned" },
        },
        {
          kind: "segment",
          ownerNodeId: "summary-owner",
          sourceNodeIds: ["summary-source"],
          content: "summary",
          freshness: "fresh",
        },
        {
          kind: "current",
          message: { role: "user", content: "current" },
        },
      ],
    );

    await new GeminiProApi().chat({
      messages,
      config: {
        model: "gemini-2.0-flash",
        providerName: ServiceProvider.Google,
        max_tokens: 128,
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
