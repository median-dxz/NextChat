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
import { chatSession, conversationNode, linearConversation } from "./fixtures/conversation";
import { createDeferredClientApi } from "./helpers/deferred-client-api";
import { createInMemorySessionStore } from "./helpers/session-repository";
import { ModelType } from "@/app/store";

function createHarness(session: ChatOrchestratorSession) {
  const repository = createInMemorySessionStore([session]);
  const provider = createDeferredClientApi();
  const dispatch = vi.fn();
  const tools = {
    definitions: [
      {
        type: "function",
        function: { name: "target-tool", parameters: {} },
      },
    ],
    handlers: { "target-tool": vi.fn() },
  };
  const orchestrator = createChatOrchestrator({
    getSession: repository.getSession,
    updateSession: repository.updateSession,
    createClient: () => provider.api,
    resolveTools: (pluginIds) => (pluginIds.length > 0 ? tools : undefined),
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
    const session = chatSession(undefined, {
      id: "reasoning",
      modelConfig: { model: "target-model" as ModelType },
      pluginIds: ["target-plugin"],
    });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "question",
    });
    expect(provider.requests[0]).toMatchObject({
      config: { model: "target-model" },
      tools: { definitions: [{ function: { name: "target-tool" } }] },
    });
    expect(provider.requests[0]).not.toHaveProperty("pluginIds");
    expect(provider.requests[0].config).not.toHaveProperty("providerName");
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
      kind: "input",
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
        .messages.find((message) => message.id === handle.assistantNodeId)?.reasoningDurationMs,
    ).toBe(12_000);
  });

  test("cancels explicitly and ignores a late Provider finish", async () => {
    const session = chatSession(undefined, { id: "cancel" });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "question",
    });
    provider.update(0, "partial answer");
    handle.cancel();
    await expect(handle.completion).resolves.toMatchObject({
      status: "cancelled",
    });
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
      kind: "input",
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

  test("retries a user by preserving it and replacing its direct response", async () => {
    const graph = linearConversation([
      { id: "old-user", role: "user", content: "question" },
      { id: "old-assistant", role: "assistant", content: "old answer" },
      { id: "later", role: "user", content: "later question" },
    ]);
    const session = chatSession(graph, { id: "user-retry" });
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: "old-user",
    });
    const retried = repository.getSession(session.id)!;
    const ids = retried.messages.map((message) => message.id);

    expect(handle.userNodeId).toBe("old-user");
    expect(ids).toContain("old-user");
    expect(ids).not.toContain("old-assistant");
    expect(ids).toContain("later");
    expect(retried.messages.find((message) => message.id === "later")?.parentId).toBe(
      handle.assistantNodeId,
    );
    expect(retried.rootNodeId).toBe(handle.userNodeId);
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual(["question"]);
  });

  test("retries a non-root user in its original projected position", async () => {
    const graph = linearConversation([
      { id: "intro-user", role: "user", content: "intro" },
      { id: "intro-assistant", role: "assistant", content: "intro answer" },
      { id: "old-user", role: "user", content: "question" },
      { id: "old-assistant", role: "assistant", content: "old answer" },
      { id: "later", role: "user", content: "later question" },
    ]);
    const session = chatSession(graph, { id: "non-root-user-retry" });
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: "old-user",
    });
    const retried = repository.getSession(session.id)!;
    const user = retried.messages.find((message) => message.id === handle.userNodeId)!;
    const later = retried.messages.find((message) => message.id === "later")!;

    expect(user.parentId).toBe("intro-assistant");
    expect(later.parentId).toBe(handle.assistantNodeId);
    expect(retried.rootNodeId).toBe("intro-user");
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual([
      "intro",
      "intro answer",
      "question",
    ]);
  });

  test("creates a selected deeper branch for one-shot outline input", async () => {
    const graph = linearConversation([{ id: "root", role: "user", content: "root" }]);
    const session = chatSession(graph, {
      id: "branch-input",
      pendingOutlineDelta: 1,
    });
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "branch question",
    });
    const updated = repository.getSession(session.id)!;
    const root = updated.messages.find((message) => message.id === "root")!;
    const user = updated.messages.find((message) => message.id === handle.userNodeId)!;
    const assistant = updated.messages.find((message) => message.id === handle.assistantNodeId)!;

    expect(root.activeBranchRootId).toBe(user.id);
    expect(user).toMatchObject({ parentId: root.id, outlineLevel: 2 });
    expect(assistant).toMatchObject({ parentId: user.id, outlineLevel: 2 });
    expect(updated.activeCursorId).toBe(assistant.id);
    expect(updated.pendingOutlineDelta).toBeUndefined();
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual([
      "root",
      "branch question",
    ]);
  });

  test("moves to the lower-level ancestor before one-shot outline input", async () => {
    const root = conversationNode({
      id: "root",
      role: "user",
      activeBranchRootId: "branch",
    });
    const branch = conversationNode({
      id: "branch",
      role: "assistant",
      parentId: root.id,
      outlineLevel: 2,
    });
    const session = chatSession(
      {
        messages: [root, branch],
        rootNodeId: root.id,
        activeCursorId: branch.id,
      },
      { id: "outdent-input", pendingOutlineDelta: -1 },
    );
    const { orchestrator, provider, repository } = createHarness(session);

    const handle = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "main question",
    });
    const updated = repository.getSession(session.id)!;
    const user = updated.messages.find((message) => message.id === handle.userNodeId)!;
    const assistant = updated.messages.find((message) => message.id === handle.assistantNodeId)!;

    expect(user).toMatchObject({ parentId: root.id, outlineLevel: 1 });
    expect(assistant).toMatchObject({ parentId: user.id, outlineLevel: 1 });
    expect(updated.pendingOutlineDelta).toBeUndefined();
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual([
      "root",
      "branch",
      "main question",
    ]);
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
        kind: "retry",
        sessionId: session.id,
        sourceNodeId: "user",
      }),
    ).rejects.toThrow("exceed the context window");

    expect(repository.getSession(session.id)).toEqual(original);
    expect(provider.requests).toEqual([]);
  });
});
