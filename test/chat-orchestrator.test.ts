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
import {
  chatSession,
  conversationNode,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";
import { createDeferredClientApi } from "./helpers/deferred-client-api";
import { createInMemorySessionStore } from "./helpers/session-repository";
import { ModelType } from "@/app/store";
import type { ChatOptions } from "../app/client/api";
import { useChatControllerStore } from "../app/store/chat-controller";

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
    withStructure: async (_sessionId, action) => action(),
    getSession: repository.getSession,
    updateSession: repository.updateSession,
    createClient: () => provider.api,
    resolveTools: (pluginIds) => (pluginIds.length > 0 ? tools : undefined),
    completionEffects: { dispatch },
  });
  return { orchestrator, provider, repository, dispatch };
}

afterEach(async () => {
  useChatControllerStore.getState().cancelAll();
  await Promise.resolve();
  vi.useRealTimers();
});

describe("chat orchestrator", () => {
  test("cancels before the Provider supplies a controller and rejects a late finish", async () => {
    const session = chatSession(undefined, { id: "delayed-controller" });
    const { orchestrator, provider, repository, dispatch } = createHarness(session);
    let request!: ChatOptions;
    provider.api.llm.chat = async (options) => {
      request = options;
    };

    const handle = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "question",
    });
    useChatControllerStore.getState().cancel(handle.assistantNodeId);
    await expect(handle.completion).resolves.toMatchObject({ status: "cancelled" });

    const controller = new AbortController();
    request.onController?.(controller);
    request.onFinish("late answer", new Response());
    expect(controller.signal.aborted).toBe(true);
    expect(repository.getSession(session.id)!.messages.at(-1)).toMatchObject({
      content: "",
      streaming: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("single-message cancellation leaves another session running, then global stop cancels it", async () => {
    const firstSession = chatSession(undefined, { id: "first" });
    const secondSession = chatSession(undefined, { id: "second" });
    const first = createHarness(firstSession);
    const second = createHarness(secondSession);
    const a = await first.orchestrator.start({
      kind: "input",
      sessionId: firstSession.id,
      content: "a",
    });
    const b = await second.orchestrator.start({
      kind: "input",
      sessionId: secondSession.id,
      content: "b",
    });

    useChatControllerStore.getState().cancel(a.assistantNodeId);
    await expect(a.completion).resolves.toMatchObject({ status: "cancelled" });
    expect(second.provider.controllers[0].signal.aborted).toBe(false);
    second.provider.update(0, "still answering");
    useChatControllerStore.getState().cancelAll();
    await expect(b.completion).resolves.toMatchObject({ status: "cancelled" });
    expect(second.provider.controllers[0].signal.aborted).toBe(true);
    expect(second.repository.getSession(secondSession.id)!.messages.at(-1)).toMatchObject({
      content: "still answering",
      streaming: false,
    });
    expect(first.dispatch).not.toHaveBeenCalled();
    expect(second.dispatch).not.toHaveBeenCalled();
  });

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
      repository.getSession(session.id)!.messages.find((node) => node.id === handle.userNodeId),
    ).toMatchObject({ isError: false, content: "question" });
    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === handle.assistantNodeId),
    ).toMatchObject({ streaming: false, isError: true });
  });

  test.each([401, 503])(
    "treats HTTP %i as a failed run even when the Provider calls onFinish",
    async (status) => {
      const session = chatSession();
      const { orchestrator, provider, repository, dispatch } = createHarness(session);
      const run = await orchestrator.start({
        kind: "input",
        sessionId: session.id,
        content: "question",
      });
      provider.finish(0, "provider HTTP error", status);
      await expect(run.completion).resolves.toMatchObject({
        status: "failed",
        error: expect.objectContaining({ message: "provider HTTP error" }),
      });

      const failed = repository.getSession(session.id)!;
      expect(failed.messages.find((node) => node.id === run.userNodeId)?.isError).toBe(false);
      expect(failed.messages.find((node) => node.id === run.assistantNodeId)).toMatchObject({
        isError: true,
        streaming: false,
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  test("retries a failed run using the same valid input", async () => {
    const session = chatSession();
    const { orchestrator, provider, repository } = createHarness(session);
    const first = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "question",
    });
    provider.fail(0, new Error("provider failed"));
    await first.completion;

    const retry = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: first.assistantNodeId,
    });

    expect(retry.userNodeId).toBe(first.userNodeId);
    expect(retry.assistantNodeId).toBe(first.assistantNodeId);
    expect(provider.requests[1].messages).toEqual([{ role: "user", content: "question" }]);

    provider.finish(1, "answer");
    await expect(retry.completion).resolves.toMatchObject({
      status: "completed",
      userNodeId: first.userNodeId,
      assistantNodeId: first.assistantNodeId,
    });

    expect(
      repository.getSession(session.id)!.messages.find((node) => node.id === first.assistantNodeId),
    ).toMatchObject({ content: "answer", isError: false, streaming: false });
    expect(
      repository.getSession(session.id)!.messages.find((node) => node.id === first.userNodeId)
        ?.isError,
    ).toBe(false);
  });

  test("retries a legacy failed input without a response and preserves its later chain", async () => {
    const session = chatSession(
      linearConversation([
        { id: "user", role: "user", content: "question", isError: true },
        { id: "later", role: "user", content: "later question" },
      ]),
    );
    const { orchestrator, provider, repository } = createHarness(session);
    const retry = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: "user",
    });
    const retried = repository.getSession(session.id)!;
    expect(retry.userNodeId).toBe("user");
    expect(retried.messages.find((node) => node.id === "user")?.isError).toBe(false);
    expect(retried.messages.find((node) => node.id === "later")?.parentId).toBe(
      retry.assistantNodeId,
    );
    expect(provider.requests[0].messages).toEqual([{ role: "user", content: "question" }]);
  });

  test("resets reply data and its summaries while preserving all reply branches", async () => {
    const user = conversationNode({ id: "user", role: "user", content: "question" });
    const assistant = conversationNode({
      id: "assistant",
      role: "assistant",
      parentId: user.id,
      content: "old answer",
      reasoning: "old reasoning",
      reasoningDurationMs: 1200,
      tools: [{ id: "old-tool" }],
      audio_url: "old-audio",
      isError: true,
      isMcpResponse: true,
      activeBranchRootId: "active",
    });
    assistant.nodeSummaries = {
      segment: generatedSummary([user, assistant]),
      checkpoint: generatedSummary([user, assistant]),
    };
    const later = conversationNode({ id: "later", role: "user", parentId: assistant.id });
    const active = conversationNode({
      id: "active",
      role: "user",
      parentId: assistant.id,
      outlineLevel: 2,
    });
    const inactive = conversationNode({
      id: "inactive",
      role: "user",
      parentId: assistant.id,
      outlineLevel: 2,
    });
    const session = chatSession({
      messages: [user, assistant, later, active, inactive],
      rootNodeId: user.id,
      activeCursorId: later.id,
    });
    const { orchestrator, repository, provider } = createHarness(session);

    const retry = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: assistant.id,
    });
    const retried = repository.getSession(session.id)!;
    const reply = retried.messages.find((node) => node.id === assistant.id)!;
    expect(retry.assistantNodeId).toBe(assistant.id);
    expect(reply).toMatchObject({
      content: "",
      reasoning: "",
      tools: [],
      streaming: true,
      isError: false,
      isMcpResponse: false,
      activeBranchRootId: active.id,
      parentId: user.id,
    });
    expect(reply).not.toHaveProperty("reasoningDurationMs");
    expect(reply).not.toHaveProperty("audio_url");
    expect(reply).not.toHaveProperty("nodeSummaries");
    expect(
      retried.messages.filter((node) => [later.id, active.id, inactive.id].includes(node.id)),
    ).toEqual([later, active, inactive]);
    expect(provider.requests[0].messages).toEqual([{ role: "user", content: "question" }]);
    expect(retried.activeCursorId).toBe(assistant.id);
  });

  test("cancels the previous run before reuse and ignores all of its late callbacks", async () => {
    const session = chatSession();
    const { orchestrator, provider, repository, dispatch } = createHarness(session);
    const first = await orchestrator.start({
      kind: "input",
      sessionId: session.id,
      content: "question",
    });
    provider.update(0, "old partial");
    const retry = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: first.userNodeId,
    });
    expect(retry.assistantNodeId).toBe(first.assistantNodeId);
    expect(provider.controllers[0].signal.aborted).toBe(true);
    await expect(first.completion).resolves.toMatchObject({ status: "cancelled" });
    expect(useChatControllerStore.getState().runs.has(retry.assistantNodeId)).toBe(true);

    provider.update(1, "new partial");
    provider.reasoning(1, "new reasoning");
    provider.requests[1].onBeforeTool?.({ id: "tool", content: "new tool" });
    provider.requests[1].onAfterTool?.({ id: "tool", content: "new tool result" });
    expect(
      repository.getSession(session.id)!.messages.find((node) => node.id === retry.assistantNodeId),
    ).toMatchObject({
      content: "new partial",
      reasoning: "new reasoning",
      tools: [{ id: "tool", content: "new tool result" }],
    });
    const snapshot = structuredClone(repository.getSession(session.id));
    provider.update(0, "late old partial");
    provider.reasoning(0, "late old reasoning");
    provider.requests[0].onBeforeTool?.({ id: "late-tool" });
    provider.requests[0].onAfterTool?.({ id: "tool", content: "late old tool" });
    provider.finish(0, "late old answer");
    provider.fail(0, new Error("late old error"));
    await Promise.resolve();
    expect(repository.getSession(session.id)).toEqual(snapshot);
    expect(dispatch).not.toHaveBeenCalled();

    provider.finish(1, "new answer");
    await expect(retry.completion).resolves.toMatchObject({ status: "completed" });
    provider.update(0, "late after completion");
    provider.update(1, "late new partial");
    expect(
      repository.getSession(session.id)!.messages.find((node) => node.id === retry.assistantNodeId),
    ).toMatchObject({ content: "new answer", streaming: false, isError: false });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("a new reply adopts selected and unselected branches even before an outdent", async () => {
    const root = conversationNode({ id: "root", role: "user", activeBranchRootId: "user" });
    const user = conversationNode({
      id: "user",
      role: "user",
      content: "question",
      parentId: root.id,
      outlineLevel: 2,
      activeBranchRootId: "active",
    });
    const active = conversationNode({
      id: "active",
      role: "user",
      parentId: user.id,
      outlineLevel: 3,
    });
    const inactive = conversationNode({
      id: "inactive",
      role: "user",
      parentId: user.id,
      outlineLevel: 3,
    });
    const later = conversationNode({ id: "later", role: "user", parentId: root.id });
    const session = chatSession({
      messages: [root, user, active, inactive, later],
      rootNodeId: root.id,
      activeCursorId: later.id,
    });
    const { orchestrator, provider, repository } = createHarness(session);
    const retry = await orchestrator.start({
      kind: "retry",
      sessionId: session.id,
      sourceNodeId: user.id,
    });
    const retried = repository.getSession(session.id)!;

    expect(retried.messages.find((node) => node.id === retry.assistantNodeId)).toMatchObject({
      parentId: user.id,
      outlineLevel: 2,
      activeBranchRootId: active.id,
    });
    expect(
      retried.messages.find((node) => node.id === user.id)?.activeBranchRootId,
    ).toBeUndefined();
    for (const branch of [active, inactive]) {
      expect(retried.messages.find((node) => node.id === branch.id)).toEqual({
        ...branch,
        parentId: retry.assistantNodeId,
      });
    }
    expect(retried.messages.find((node) => node.id === later.id)).toEqual(later);
    expect(provider.requests[0].messages.map((node) => node.content)).toEqual(["root", "question"]);
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
