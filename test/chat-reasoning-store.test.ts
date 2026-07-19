import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClientApi } from "../app/client/api";

const apiMocks = vi.hoisted(() => ({
  chat: vi.fn(),
}));

vi.mock("../app/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/client/api")>()),
  getClientApi: () => ({ llm: { chat: apiMocks.chat } }),
}));

vi.mock("../app/mcp/actions", () => ({
  executeMcpAction: vi.fn(),
  getAllTools: vi.fn().mockResolvedValue([]),
  isMcpEnabled: vi.fn().mockResolvedValue(false),
}));

import {
  ChatMessage,
  ChatSession,
  DEFAULT_TOPIC,
  createConversationNode,
  useChatStore,
} from "../app/store/chat";
import { useAppConfig } from "../app/store/config";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import { getMessageTextContent } from "../app/utils";
import {
  Conversation,
  createMessage,
  createSourceDigest,
} from "../app/utils/conversation";
import { getProviderContextAdapter } from "../app/client/provider-context";
import {
  createSummaryMaintenance,
  type SummaryMaintenance,
} from "../app/store/summary-maintenance";

const initialSession = structuredClone(useChatStore.getState().sessions[0]);
const initialConfig = useAppConfig.getState();
let summaryMaintenance: SummaryMaintenance;

function message(
  role: ChatMessage["role"],
  content: string,
  reasoning?: string,
): ChatMessage {
  return {
    id: `${role}-${content}`,
    date: "",
    role,
    content,
    reasoning,
  };
}

function linearNodes(messages: ChatMessage[]) {
  let parentId: string | undefined;
  return messages.map((item) => {
    const node = createConversationNode({
      ...item,
      parentId,
      outlineLevel: 1,
      activeBranchRootId: undefined,
    });
    parentId = node.id;
    return node;
  });
}

function setSession(
  messages: ChatMessage[],
  modelConfig: Partial<ChatSession["mask"]["modelConfig"]> = {},
) {
  const session = structuredClone(initialSession);
  session.messages = linearNodes(messages);
  session.rootNodeId = session.messages[0]?.id;
  session.activeCursorId = session.messages.at(-1)?.id;
  session.topic = DEFAULT_TOPIC;
  session.mask.modelConfig = {
    ...session.mask.modelConfig,
    enableInjectSystemPrompts: false,
    ...modelConfig,
  };
  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
  return session;
}

function assembleHistory(
  session: ChatSession,
  currentInput: ChatMessage,
) {
  const assembly = Conversation(session).context.assemble({
    systemInputs: [],
    pinnedInputs: session.pinnedInputs,
    globalMemoryInput:
      session.globalMemory.enabled && session.globalMemory.content.trim()
        ? createMessage({
            role: "system",
            content: session.globalMemory.content,
            date: "",
          })
        : undefined,
    currentInput,
    budget: {
      contextWindowTokens: session.mask.modelConfig.contextWindowTokens,
      requestedOutputTokens: session.mask.modelConfig.max_tokens,
    },
    recentRawNodeCount: session.mask.modelConfig.recentRawNodeCount,
    summaries: session.mask.modelConfig.sendMemory ? "enabled" : "disabled",
  });
  return getProviderContextAdapter(
    session.mask.modelConfig.providerName,
  ).materialize(assembly.entries.slice(0, -1));
}

beforeEach(() => {
  apiMocks.chat.mockReset();
  useChatStore.setState({
    sessions: [structuredClone(initialSession)],
    currentSessionIndex: 0,
    lastInput: "",
    _hasHydrated: true,
  });
  useAppConfig.setState({
    enableAutoGenerateTitle: false,
  });
  summaryMaintenance = createSummaryMaintenance({
    getSession: (sessionId) =>
      useChatStore
        .getState()
        .sessions.find((session) => session.id === sessionId),
    updateSession(sessionId, updater) {
      const store = useChatStore.getState();
      const session = store.sessions.find((item) => item.id === sessionId);
      if (session) store.updateTargetSession(session, updater);
    },
    getClientApi: () =>
      ({ llm: { chat: apiMocks.chat } }) as unknown as ClientApi,
    resolveDefaultModel: (model, providerName) => [model, providerName],
    summaryPrompt: "Summarize the conversation",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAppConfig.setState(initialConfig);
});

describe("chat store derived state", () => {
  test("builds provider history from the active graph branch and fixed inputs", async () => {
    const session = setSession([], {
      sendMemory: false,
      recentRawNodeCount: 20,
      contextWindowTokens: 32_000,
    });
    const root = createConversationNode({
      id: "root",
      role: "user",
      content: "root",
      outlineLevel: 1,
      activeBranchRootId: "active-branch",
    });
    const activeBranch = createConversationNode({
      id: "active-branch",
      role: "assistant",
      content: "active branch",
      outlineLevel: 2,
      parentId: root.id,
    });
    const inactiveBranch = createConversationNode({
      id: "inactive-branch",
      role: "assistant",
      content: "inactive branch",
      outlineLevel: 2,
      parentId: root.id,
    });
    const continuation = createConversationNode({
      id: "continuation",
      role: "assistant",
      content: "continuation",
      outlineLevel: 1,
      parentId: root.id,
    });
    session.messages = [root, activeBranch, inactiveBranch, continuation];
    session.rootNodeId = root.id;
    session.activeCursorId = continuation.id;
    session.pinnedInputs = [message("user", "pinned")];
    session.globalMemory = {
      enabled: true,
      prompt: "",
      content: "global memory",
      revision: 0,
    };

    const history = assembleHistory(session, message("user", "current"));

    expect(history.map((item) => item.content)).toEqual([
      "global memory",
      "pinned",
      "root",
      "active branch",
      "continuation",
    ]);
  });

  test("forks graph nodes and remaps root, cursor, and parent references", () => {
    const original = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    original.pinnedInputs = [message("system", "pinned")];
    original.globalMemory = {
      enabled: true,
      prompt: "remember",
      content: "memory",
      revision: 2,
    };

    useChatStore.getState().forkSession();

    const fork = useChatStore.getState().sessions[0];
    expect(fork.id).not.toBe(original.id);
    expect(fork.rootNodeId).toBe(fork.messages[0].id);
    expect(fork.activeCursorId).toBe(fork.messages[1].id);
    expect(fork.messages[1].parentId).toBe(fork.messages[0].id);
    expect(fork.messages.map((item) => item.id)).not.toEqual(
      original.messages.map((item) => item.id),
    );
    expect(fork.pinnedInputs[0].id).not.toBe(original.pinnedInputs[0].id);
    expect(fork.globalMemory).toEqual(original.globalMemory);
  });

  test("migrates the v3.3 persisted session into graph context and global memory", async () => {
    const legacyMask = structuredClone(initialSession.mask) as any;
    legacyMask.context = [
      message("system", "pinned system"),
      message("user", "preset user"),
      message("assistant", "preset answer"),
    ];
    legacyMask.modelConfig.historyMessageCount = 4;
    legacyMask.modelConfig.compressMessageLengthThreshold = 1000;
    for (const key of [
      "contextWindowTokens",
      "recentRawNodeCount",
      "segmentTargetSourceTokens",
      "segmentMaxSourceNodes",
      "checkpointTargetSegments",
      "checkpointMergeTargetTokens",
      "memoryModel",
      "memoryProviderName",
      "titleModel",
      "titleProviderName",
    ]) {
      delete legacyMask.modelConfig[key];
    }
    const persistedSession = {
      id: initialSession.id,
      topic: initialSession.topic,
      memoryPrompt: "legacy memory",
      messages: [
        message("user", "question"),
        message("assistant", "answer"),
      ],
      stat: structuredClone(initialSession.stat),
      lastUpdate: initialSession.lastUpdate,
      lastSummarizeIndex: 2,
      clearContextIndex: 1,
      mask: legacyMask,
    };
    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
      JSON.stringify({
        state: {
          sessions: [persistedSession],
          currentSessionIndex: 0,
          lastInput: "",
          _hasHydrated: true,
        },
        version: 3.3,
      }),
    );

    await useChatStore.persist.rehydrate();

    const migrated = useChatStore.getState().currentSession();
    expect(migrated.globalMemory).toEqual(
      expect.objectContaining({ enabled: true, content: "legacy memory" }),
    );
    expect(migrated.pinnedInputs.map((item) => item.content)).toEqual([
      "pinned system",
    ]);
    expect((migrated.pinnedInputs[0] as any).outlineLevel).toBe(0);
    expect(migrated.messages.map((item) => item.content)).toEqual([
      "preset user",
      "preset answer",
      "question",
      "answer",
    ]);
    expect(migrated.messages.map((item) => item.outlineLevel)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(migrated.messages.slice(1).map((item) => item.parentId)).toEqual(
      migrated.messages.slice(0, -1).map((item) => item.id),
    );
    expect(migrated.rootNodeId).toBe(migrated.messages[0].id);
    expect(migrated.activeCursorId).toBe(migrated.messages.at(-1)?.id);
    expect(migrated.mask.context).toEqual([]);
    expect(migrated).not.toHaveProperty("memoryPrompt");
    expect(migrated).not.toHaveProperty("lastSummarizeIndex");
    expect(migrated).not.toHaveProperty("clearContextIndex");
  });

  test("persists reasoning and restores it during hydration", async () => {
    const persistedSession = structuredClone(initialSession) as any;
    persistedSession.messages = [
      {
        ...message("assistant", "final answer", "persisted reasoning"),
        reasoningDurationMs: 65_000,
      },
    ];
    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
      JSON.stringify({
        state: {
          sessions: [persistedSession],
          currentSessionIndex: 0,
          lastInput: "",
          lastUpdateTime: 0,
          _hasHydrated: true,
        },
        version: 3.3,
      }),
    );

    setSession([]);
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().currentSession().messages[0].reasoning).toBe(
      "persisted reasoning",
    );
    expect(
      useChatStore.getState().currentSession().messages[0].reasoningDurationMs,
    ).toBe(65_000);
  });

  test("preserves an intentionally empty graph cursor during hydration", async () => {
    const persistedSession = structuredClone(initialSession);
    persistedSession.messages = linearNodes([
      message("user", "root"),
      message("assistant", "tail"),
    ]);
    persistedSession.rootNodeId = persistedSession.messages[0].id;
    persistedSession.activeCursorId = undefined;
    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
      JSON.stringify({
        state: {
          sessions: [persistedSession],
          currentSessionIndex: 0,
          lastInput: "",
          lastUpdateTime: 0,
          _hasHydrated: true,
        },
        version: 4.3,
      }),
    );

    await useChatStore.persist.rehydrate();

    expect(
      useChatStore.getState().currentSession().activeCursorId,
    ).toBeUndefined();
  });

  test("stops a persisted reasoning stream during hydration", async () => {
    const persistedSession = structuredClone(initialSession) as any;
    persistedSession.messages = [
      {
        ...message("assistant", "", "partial reasoning"),
        streaming: true,
      },
    ];
    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
      JSON.stringify({
        state: {
          sessions: [persistedSession],
          currentSessionIndex: 0,
          lastInput: "",
          lastUpdateTime: 0,
          _hasHydrated: true,
        },
        version: 4.2,
      }),
    );

    setSession([]);
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().currentSession().messages[0]).toEqual(
      expect.objectContaining({
        content: "",
        reasoning: "partial reasoning",
        streaming: false,
      }),
    );
  });

  test("separates run completion and records reasoning duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    setSession([]);
    let chatOptions: any;
    apiMocks.chat.mockImplementation((options) => {
      chatOptions = options;
    });

    const handle = await useChatStore.getState().onUserInput("question");
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });
    chatOptions.onReasoningUpdate("partial reasoning");
    vi.advanceTimersByTime(65_000);
    expect(completed).toBe(false);
    await chatOptions.onFinish("", new Response(null, { status: 200 }));
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      assistantNodeId: handle.assistantNodeId,
    });

    expect(useChatStore.getState().currentSession().messages.at(-1)).toEqual(
      expect.objectContaining({
        reasoning: "partial reasoning",
        reasoningDurationMs: 65_000,
        streaming: false,
      }),
    );
  });

  test("stops measuring reasoning when final content starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    setSession([]);
    let chatOptions: any;
    apiMocks.chat.mockImplementation((options) => {
      chatOptions = options;
    });

    await useChatStore.getState().onUserInput("question");
    chatOptions.onReasoningUpdate("reasoning");
    vi.advanceTimersByTime(12_000);
    chatOptions.onUpdate("final answer");
    vi.advanceTimersByTime(30_000);
    await chatOptions.onFinish(
      "final answer",
      new Response(null, { status: 200 }),
    );

    expect(
      useChatStore.getState().currentSession().messages.at(-1)
        ?.reasoningDurationMs,
    ).toBe(12_000);
  });

  test("cancels explicitly and ignores a late provider finish", async () => {
    const session = setSession([]);
    let chatOptions: any;
    const controller = new AbortController();
    apiMocks.chat.mockImplementation((options) => {
      chatOptions = options;
      options.onController(controller);
    });

    const handle = await useChatStore.getState().onUserInput("question");
    chatOptions.onUpdate("partial answer");
    handle.cancel();
    await expect(handle.completion).resolves.toMatchObject({
      status: "cancelled",
    });
    chatOptions.onFinish("late answer", new Response(null, { status: 200 }));

    expect(controller.signal.aborted).toBe(true);
    expect(session.stat.tokenCount).toBe(0);
    const cancelledMessage = useChatStore
      .getState()
      .currentSession()
      .messages.at(-1);
    expect(cancelledMessage).toMatchObject({
      content: "partial answer",
      streaming: false,
    });
    expect(cancelledMessage?.isError).toBeFalsy();
  });

  test("settles provider errors as failed without completion effects", async () => {
    const session = setSession([]);
    let chatOptions: any;
    apiMocks.chat.mockImplementation((options) => {
      chatOptions = options;
    });

    const handle = await useChatStore.getState().onUserInput("question");
    chatOptions.onError(new Error("provider failed"));

    await expect(handle.completion).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ message: "provider failed" }),
    });
    expect(session.stat.tokenCount).toBe(0);
    expect(
      useChatStore.getState().currentSession().messages.at(-1),
    ).toMatchObject({ streaming: false, isError: true });
  });

  test("retries an assistant by preserving its user node", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "old answer"),
    ]);
    const userId = session.messages[0].id;
    const assistantId = session.messages[1].id;
    let requestedMessages: ChatMessage[] = [];
    apiMocks.chat.mockImplementation((options) => {
      requestedMessages = options.messages;
    });

    await useChatStore.getState().retryMessage(session.id, assistantId);

    const retried = useChatStore.getState().currentSession();
    expect(retried.messages).toHaveLength(2);
    expect(retried.messages[0].id).toBe(userId);
    expect(retried.messages[1]).toMatchObject({
      role: "assistant",
      parentId: userId,
      streaming: true,
    });
    expect(retried.messages[1].id).not.toBe(assistantId);
    expect(requestedMessages.map(getMessageTextContent)).toEqual(["question"]);
  });

  test("retries a user by replacing the direct user and assistant nodes", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "old answer"),
      message("user", "later question"),
    ]);
    const oldUserId = session.messages[0].id;
    const oldAssistantId = session.messages[1].id;
    const laterId = session.messages[2].id;
    apiMocks.chat.mockImplementation(() => undefined);

    await useChatStore.getState().retryMessage(session.id, oldUserId);

    const retried = useChatStore.getState().currentSession();
    const ids = retried.messages.map((item) => item.id);
    expect(ids).not.toContain(oldUserId);
    expect(ids).not.toContain(oldAssistantId);
    expect(ids).toContain(laterId);
    const replacementUser = retried.messages.find(
      (item) => item.role === "user" && item.id !== laterId,
    )!;
    const replacementAssistant = retried.messages.find(
      (item) => item.role === "assistant",
    )!;
    expect(retried.messages.find((item) => item.id === laterId)?.parentId).toBe(
      replacementAssistant.id,
    );
    expect(replacementAssistant.parentId).toBe(replacementUser.id);
    expect(retried.rootNodeId).toBe(replacementUser.id);
  });

  test("keeps the original retry graph when context validation fails", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "old answer")],
      { contextWindowTokens: 128, max_tokens: 128 },
    );
    const originalGraph = structuredClone({
      messages: session.messages,
      rootNodeId: session.rootNodeId,
      activeCursorId: session.activeCursorId,
    });

    await expect(
      useChatStore
        .getState()
        .retryMessage(session.id, session.messages[1].id),
    ).rejects.toThrow("exceed the context window");

    expect(useChatStore.getState().currentSession()).toMatchObject(
      originalGraph,
    );
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("coalesces summary maintenance and stores segment and checkpoint together", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    const assistantId = session.messages[1].id;
    const finishes: Array<(message: string, response: Response) => void> = [];
    apiMocks.chat.mockImplementation((options) => {
      finishes.push(options.onFinish);
    });

    const first = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: assistantId,
      force: true,
    });
    const second = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: assistantId,
      force: true,
    });
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(1));
    finishes[0]("compact answer", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(2));
    finishes[1]("compact history", new Response(null, { status: 200 }));
    await Promise.all([first, second]);

    const assistant = useChatStore
      .getState()
      .currentSession()
      .messages.find((item) => item.id === assistantId)!;
    expect((assistant as any).summaryAttemptedAt).toBeUndefined();
    expect(assistant.nodeSummaries?.segment).toEqual(
      expect.objectContaining({
        content: "compact answer",
        sourceNodeIds: session.messages.map((item) => item.id),
        sourceDigest: expect.any(String),
        provenance: "generated",
      }),
    );
    expect(assistant.nodeSummaries?.checkpoint).toEqual(
      expect.objectContaining({
        content: "compact history",
        sourceNodeIds: session.messages.map((item) => item.id),
        sourceDigest: expect.any(String),
        provenance: "generated",
      }),
    );
  });

  test("regenerates and deletes one node-summary kind independently", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    const assistantId = session.messages[1].id;
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish(
        "segment only",
        new Response(null, { status: 200 }),
      );
    });

    await summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: assistantId,
      force: true,
      onlyKind: "segment",
    });

    const assistant = useChatStore
      .getState()
      .currentSession()
      .messages.find((item) => item.id === assistantId)!;
    expect(assistant.nodeSummaries?.segment?.content).toBe("segment only");
    expect(assistant.nodeSummaries?.checkpoint).toBeUndefined();

    useChatStore
      .getState()
      .deleteNodeSummary(session.id, assistantId, "segment");
    expect(
      useChatStore
        .getState()
        .currentSession()
        .messages.find((item) => item.id === assistantId)?.nodeSummaries,
    ).toBeUndefined();
  });

  test("does not block sending or overwrite an edit made during generation", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    const assistantId = session.messages[1].id;
    const finishes: Array<(message: string, response: Response) => void> = [];
    apiMocks.chat.mockImplementation((options) => {
      finishes.push(options.onFinish);
    });

    const generating = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: assistantId,
      force: true,
    });
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(1));
    expect(assembleHistory(session, message("user", "current"))).toEqual([
      expect.objectContaining({ content: "question" }),
      expect.objectContaining({ content: "answer" }),
    ]);

    useChatStore.getState().updateTargetSession(session, (draft) => {
      const assistant = draft.messages.find((item) => item.id === assistantId)!;
      assistant.nodeSummaries = {
        segment: {
          content: "manual summary",
          sourceNodeIds: draft.messages.map((item) => item.id),
          sourceDigest: createSourceDigest(draft.messages),
          provenance: "user-edited",
        },
      };
    });
    finishes[0]("late generated summary", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(2));
    finishes[1]("checkpoint", new Response(null, { status: 200 }));
    await generating;

    expect(
      useChatStore
        .getState()
        .currentSession()
        .messages.find((item) => item.id === assistantId)?.nodeSummaries
        ?.segment,
    ).toEqual(
      expect.objectContaining({
        content: "manual summary",
        provenance: "user-edited",
      }),
    );
  });

  test("does not overwrite a checkpoint edited during generation", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    const assistantId = session.messages[1].id;
    const finishes: Array<(message: string, response: Response) => void> = [];
    apiMocks.chat.mockImplementation((options) => {
      finishes.push(options.onFinish);
    });

    const generating = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: assistantId,
      force: true,
    });
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    finishes[0]("segment", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(finishes).toHaveLength(2));

    const current = useChatStore.getState().currentSession();
    useChatStore.getState().updateTargetSession(current, (draft) => {
      const assistant = draft.messages.find((item) => item.id === assistantId)!;
      assistant.nodeSummaries ??= {};
      assistant.nodeSummaries.checkpoint = {
        content: "manual checkpoint",
        sourceNodeIds: draft.messages.map((item) => item.id),
        sourceDigest: createSourceDigest(draft.messages),
        provenance: "user-edited",
      };
    });
    finishes[1]("late checkpoint", new Response(null, { status: 200 }));
    await generating;

    expect(
      useChatStore
        .getState()
        .currentSession()
        .messages.find((item) => item.id === assistantId)?.nodeSummaries
        ?.checkpoint,
    ).toEqual(
      expect.objectContaining({
        content: "manual checkpoint",
        provenance: "user-edited",
      }),
    );
  });

  test("serializes segment generation within one outline chain", async () => {
    const session = setSession(
      [
        message("user", "question one"),
        message("assistant", "answer one"),
        message("user", "question two"),
        message("assistant", "answer two"),
      ],
      { segmentTargetSourceTokens: 0 },
    );
    const firstOwnerId = session.messages[1].id;
    const secondOwnerId = session.messages[3].id;
    const finishes: Array<(message: string, response: Response) => void> = [];
    apiMocks.chat.mockImplementation((options) => {
      finishes.push(options.onFinish);
    });

    const first = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: firstOwnerId,
    });
    const second = summaryMaintenance.maintain({
      sessionId: session.id,
      targetNodeId: secondOwnerId,
    });
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(1));
    finishes[0]("first segment", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(apiMocks.chat).toHaveBeenCalledTimes(2));
    finishes[1]("second segment", new Response(null, { status: 200 }));
    await Promise.all([first, second]);

    const current = useChatStore.getState().currentSession();
    expect(current.messages[1].nodeSummaries?.segment?.sourceNodeIds).toEqual(
      current.messages.slice(0, 2).map((item) => item.id),
    );
    expect(current.messages[3].nodeSummaries?.segment?.sourceNodeIds).toEqual(
      current.messages.slice(2, 4).map((item) => item.id),
    );
  });

  test("serializes global memory updates", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    const requests: any[] = [];
    apiMocks.chat.mockImplementation((options) => requests.push(options));

    const first = useChatStore.getState().updateGlobalMemory(session.id);
    const second = useChatStore.getState().updateGlobalMemory(session.id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0].onFinish("memory one", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1].onFinish("memory two", new Response(null, { status: 200 }));
    await Promise.all([first, second]);

    expect(useChatStore.getState().currentSession().globalMemory).toMatchObject(
      {
        content: "memory two",
        revision: 2,
      },
    );
  });

  test("uses the configured conversation memory model", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "answer")],
      {
        memoryModel: "memory-model",
        memoryProviderName: "OpenAI",
      },
    );
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish("new memory", new Response(null, { status: 200 }));
    });

    await useChatStore.getState().updateGlobalMemory(session.id);

    expect(apiMocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "memory-model",
          providerName: "OpenAI",
        }),
      }),
    );
  });

  test("allows a one-off conversation memory model override", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "answer")],
      {
        memoryModel: "configured-model",
        memoryProviderName: "OpenAI",
      },
    );
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish("new memory", new Response(null, { status: 200 }));
    });

    await useChatStore.getState().updateGlobalMemory(session.id, undefined, {
      model: "temporary-model",
      providerName: "Google",
    });

    expect(apiMocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "temporary-model",
          providerName: "Google",
        }),
      }),
    );
  });

  test("does not overwrite a manual global memory edit", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    let finish: ((message: string, response: Response) => void) | undefined;
    apiMocks.chat.mockImplementation((options) => {
      finish = options.onFinish;
    });

    const updating = useChatStore.getState().updateGlobalMemory(session.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    useChatStore
      .getState()
      .editGlobalMemory(session.id, { content: "manual memory" });
    finish?.("stale generated memory", new Response(null, { status: 200 }));
    await updating;

    expect(useChatStore.getState().currentSession().globalMemory.content).toBe(
      "manual memory",
    );
  });

  test("uses only final content from history in the next turn", async () => {
    setSession([message("assistant", "final answer", "private reasoning")]);
    let requestedMessages: ChatMessage[] = [];
    apiMocks.chat.mockImplementation((options) => {
      requestedMessages = options.messages;
    });

    await useChatStore.getState().onUserInput("next question");

    expect(requestedMessages.map(getMessageTextContent)).toEqual([
      "final answer",
      "next question",
    ]);
    expect(
      requestedMessages.map(getMessageTextContent).join("\n"),
    ).not.toContain("private reasoning");
  });

  test("allows a short first message when reply limit equals context window", async () => {
    setSession([], {
      contextWindowTokens: 1_024,
      max_tokens: 1_024,
      enableInjectSystemPrompts: false,
    });
    let requestedMaxOutputTokens = 0;
    apiMocks.chat.mockImplementation((options) => {
      requestedMaxOutputTokens = options.config.max_tokens;
    });

    await useChatStore.getState().onUserInput("hello");

    expect(requestedMaxOutputTokens).toBeGreaterThan(0);
    expect(requestedMaxOutputTokens).toBeLessThan(1_024);
  });

  test("keeps all raw nodes when they fit even if recent history count is zero", async () => {
    const session = setSession(
      [
        message("user", "old question 1"),
        message("assistant", "old answer 1"),
        message("user", "old question 2"),
        message("assistant", "old answer 2"),
      ],
      {
        sendMemory: true,
        recentRawNodeCount: 0,
        segmentTargetSourceTokens: 0,
      },
    );
    expect(
      assembleHistory(session, message("user", "current question")),
    ).toHaveLength(4);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("context planning does not block on emergency compaction", async () => {
    const session = setSession(
      [
        message("user", "a".repeat(4_000)),
        message("assistant", "b".repeat(4_000)),
        message("user", "recent question"),
        message("assistant", "recent answer"),
      ],
      {
        sendMemory: true,
        recentRawNodeCount: 2,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    expect(
      assembleHistory(session, message("user", "current question")),
    ).toEqual([
      expect.objectContaining({ content: "recent question" }),
      expect.objectContaining({ content: "recent answer" }),
    ]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("sends a compound segment plus the forced recent raw suffix", async () => {
    const session = setSession(
      [
        message("user", "old question ".repeat(400)),
        message("assistant", "old answer ".repeat(400)),
        message("user", "recent question"),
        message("assistant", "recent answer"),
      ],
      {
        sendMemory: true,
        recentRawNodeCount: 2,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    const oldSources = session.messages.slice(0, 2);
    oldSources[1].nodeSummaries = {
      segment: {
        content: "compact old history",
        sourceNodeIds: oldSources.map((item) => item.id),
        sourceDigest: createSourceDigest(oldSources),
        provenance: "generated",
      },
    };

    const history = assembleHistory(
      session,
      message("user", "current question"),
    );

    expect(history.map(getMessageTextContent)).toEqual([
      "compact old history",
      "recent question",
      "recent answer",
    ]);
    expect(history.map((item) => item.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("can use a structurally valid stale node summary without waiting", async () => {
    const session = setSession(
      [
        message("user", "old question ".repeat(400)),
        message("assistant", "old answer ".repeat(400)),
      ],
      {
        sendMemory: true,
        recentRawNodeCount: 0,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    session.messages[1].nodeSummaries = {
      segment: {
        content: "stale but available",
        sourceNodeIds: session.messages.map((item) => item.id),
        sourceDigest: "stale",
        provenance: "generated",
      },
    };

    expect(
      assembleHistory(session, message("user", "current question")),
    ).toEqual([
      { role: "assistant", content: "stale but available" },
    ]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("never sends an oversized recent window when no summary is available", async () => {
    const session = setSession(
      Array.from({ length: 12 }, (_, index) =>
        message(
          index % 2 === 0 ? "user" : "assistant",
          String(index).repeat(8_000),
        ),
      ),
      {
        sendMemory: true,
        recentRawNodeCount: 12,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    expect(
      assembleHistory(session, message("user", "current question")),
    ).toEqual([]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("does not assemble a stale summary with sources outside the projection", async () => {
    const messages = [
      message("user", "visible question".repeat(400)),
      message("assistant", "visible answer".repeat(400)),
    ];
    const session = setSession(messages, {
      sendMemory: true,
      recentRawNodeCount: 0,
      contextWindowTokens: 1_024,
      max_tokens: 128,
    });
    session.messages[1].nodeSummaries = {
      segment: {
        content: "excluded branch secret",
        sourceNodeIds: ["excluded-m1", messages[1].id],
        sourceDigest: "stale",
        provenance: "generated",
      },
    };

    const requestHistory = assembleHistory(
      session,
      message("user", "current question"),
    );

    expect(requestHistory.map(getMessageTextContent).join("\n")).not.toContain(
      "excluded branch secret",
    );
  });
});
