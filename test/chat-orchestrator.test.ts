import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../app/locales", () => ({ getLang: () => "en" }));

vi.mock("../app/mcp/actions", () => ({
  getAllTools: vi.fn().mockResolvedValue([]),
  isMcpEnabled: vi.fn().mockResolvedValue(false),
}));

import {
  createChatOrchestrator,
  type ChatOrchestratorSession,
} from "../app/store/chat-orchestrator";
import { chatSession, linearConversation } from "./fixtures/conversation";
import { createDeferredClientApi } from "./helpers/deferred-client-api";
import { createSessionRepository } from "./helpers/session-repository";

function createHarness(session: ChatOrchestratorSession) {
  const repository = createSessionRepository([session]);
  const provider = createDeferredClientApi();
  const dispatch = vi.fn();
  const orchestrator = createChatOrchestrator({
    getSession: repository.getSession,
    updateConversation: repository.updateConversation,
    getClientApi: () => provider.api,
    completionEffects: { dispatch },
  });
  return { orchestrator, provider, repository, dispatch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat orchestrator", () => {
  test("separates start from completion and records reasoning duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const session = chatSession(undefined, { id: "reasoning" });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "question",
    });
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });
    provider.reasoning(0, "partial reasoning");
    vi.advanceTimersByTime(65_000);
    expect(completed).toBe(false);
    provider.finish(0, "");

    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      assistantNodeId: handle.assistantNodeId,
    });
    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === handle.assistantNodeId),
    ).toMatchObject({
      reasoning: "partial reasoning",
      reasoningDurationMs: 65_000,
      streaming: false,
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("stops reasoning timing when final content starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const session = chatSession(undefined, { id: "timing" });
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "question",
    });
    provider.reasoning(0, "reasoning");
    vi.advanceTimersByTime(12_000);
    provider.update(0, "final answer");
    vi.advanceTimersByTime(30_000);
    provider.finish(0, "final answer");
    await handle.completion;

    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === handle.assistantNodeId)
        ?.reasoningDurationMs,
    ).toBe(12_000);
  });

  test("cancels explicitly and ignores a late Provider finish", async () => {
    const session = chatSession(undefined, { id: "cancel" });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "question",
    });
    provider.update(0, "partial answer");
    handle.cancel();
    await expect(handle.completion).resolves.toMatchObject({ status: "cancelled" });
    provider.finish(0, "late answer");

    expect(provider.controllers[0].signal.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === handle.assistantNodeId),
    ).toMatchObject({ content: "partial answer", streaming: false });
  });

  test("settles Provider errors without completion effects", async () => {
    const session = chatSession(undefined, { id: "failed" });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "question",
    });
    provider.fail(0, new Error("provider failed"));

    await expect(handle.completion).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ message: "provider failed" }),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === handle.assistantNodeId),
    ).toMatchObject({ streaming: false, isError: true });
  });

  test("retries an assistant while preserving its user node", async () => {
    const graph = linearConversation([
      { id: "user", role: "user", content: "question" },
      { id: "assistant", role: "assistant", content: "old answer" },
    ]);
    const session = chatSession(graph, { id: "assistant-retry" });
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "",
      retry: { sourceNodeId: "assistant" },
    });
    const retried = repository.getSession(session.id)!;

    expect(retried.messages).toHaveLength(2);
    expect(retried.messages[0].id).toBe("user");
    expect(retried.messages[1]).toMatchObject({
      id: handle.assistantNodeId,
      role: "assistant",
      parentId: "user",
      streaming: true,
    });
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual([
      "question",
    ]);
  });

  test("retries a user by replacing its direct response", async () => {
    const graph = linearConversation([
      { id: "old-user", role: "user", content: "question" },
      { id: "old-assistant", role: "assistant", content: "old answer" },
      { id: "later", role: "user", content: "later question" },
    ]);
    const session = chatSession(graph, { id: "user-retry" });
    const { orchestrator, repository } = createHarness(session);

    const handle = await orchestrator.start({
      sessionId: session.id,
      content: "",
      retry: { sourceNodeId: "old-user" },
    });
    const retried = repository.getSession(session.id)!;
    const ids = retried.messages.map((message) => message.id);

    expect(ids).not.toContain("old-user");
    expect(ids).not.toContain("old-assistant");
    expect(ids).toContain("later");
    expect(
      retried.messages.find((message) => message.id === "later")?.parentId,
    ).toBe(handle.assistantNodeId);
    expect(retried.rootNodeId).toBe(handle.userNodeId);
  });

  test("preserves the retry graph when Context Assembly rejects the run", async () => {
    const graph = linearConversation([
      { id: "user", role: "user", content: "question" },
      { id: "assistant", role: "assistant", content: "old answer" },
    ]);
    const session = chatSession(graph, {
      id: "invalid-retry",
      modelConfig: { contextWindowTokens: 128, max_tokens: 128 },
    });
    const { orchestrator, provider, repository } = createHarness(session);
    const original = structuredClone(repository.getSession(session.id));

    await expect(
      orchestrator.start({
        sessionId: session.id,
        content: "",
        retry: { sourceNodeId: "assistant" },
      }),
    ).rejects.toThrow("exceed the context window");

    expect(repository.getSession(session.id)).toEqual(original);
    expect(provider.requests).toEqual([]);
  });
});
