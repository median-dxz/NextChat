import { beforeEach, describe, expect, test, vi } from "vitest";

const chatMocks = vi.hoisted(() => ({
  streamWithThink: vi.fn(),
}));

vi.mock("../app/utils/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/utils/chat")>()),
  streamWithThink: chatMocks.streamWithThink,
}));

import { ChatGPTApi, RequestPayload } from "../app/client/platforms/openai";
import { ServiceProvider } from "../app/constant";

describe("OpenAI reasoning request payload", () => {
  beforeEach(() => {
    chatMocks.streamWithThink.mockClear();
  });

  test("serializes only role and final content for the next request", async () => {
    const api = new ChatGPTApi();

    await api.chat({
      messages: [
        {
          role: "model",
          content: "final answer",
          reasoning: "private reasoning",
        } as any,
        { role: "user", content: "next question" },
      ],
      config: {
        model: "gpt-4o-mini",
        providerName: ServiceProvider.OpenAI,
        temperature: 0.5,
        top_p: 1,
        max_tokens: 128,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: true,
      },
      pluginIds: [],
      onFinish: vi.fn(),
    });

    expect(chatMocks.streamWithThink).toHaveBeenCalledTimes(1);
    const payload = chatMocks.streamWithThink.mock
      .calls[0][1] as RequestPayload;
    expect(payload.max_tokens).toBe(128);
    expect(payload.messages).toEqual([
      { role: "assistant", content: "final answer" },
      { role: "user", content: "next question" },
    ]);
    expect(JSON.stringify(payload.messages)).not.toContain("private reasoning");
  });
});
