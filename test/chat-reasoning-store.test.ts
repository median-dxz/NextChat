import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  ConversationSummary,
  createSummarySourceDigest,
} from "../app/utils/context-compression";
import { toLevelOneConversationNodes } from "../app/utils/conversation-graph";

const initialSession = structuredClone(useChatStore.getState().sessions[0]);
const initialConfig = useAppConfig.getState();

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

function setSession(
  messages: ChatMessage[],
  modelConfig: Partial<ChatSession["mask"]["modelConfig"]> = {},
) {
  const session = structuredClone(initialSession);
  session.messages = toLevelOneConversationNodes(messages);
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

    const history = await useChatStore
      .getState()
      .getMessagesWithMemory(message("user", "current"));

    expect(history.map((item) => item.content)).toEqual([
      "global memory",
      "pinned",
      "root",
      "active branch",
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

  test("migrates the original memory prompt into global memory and a level-one graph", async () => {
    const persistedSession = structuredClone(initialSession) as any as {
      messages: ChatMessage[];
      memoryPrompt: string;
      lastSummarizeIndex: number;
      clearContextIndex: number;
    };
    persistedSession.messages = [
      message("user", "old question"),
      message("assistant", "old answer"),
    ];
    persistedSession.memoryPrompt = "legacy memory";
    persistedSession.lastSummarizeIndex = 2;
    persistedSession.clearContextIndex = 0;
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
    expect(migrated.messages.map((item) => item.outlineLevel)).toEqual([1, 1]);
    expect(migrated.messages[1].parentId).toBe(migrated.messages[0].id);
    expect(migrated.rootNodeId).toBe(migrated.messages[0].id);
    expect(migrated.activeCursorId).toBe(migrated.messages[1].id);
  });

  test("materializes legacy mask context and preserves its context boundary", async () => {
    const persistedSession = structuredClone(initialSession) as any;
    persistedSession.messages = [
      message("user", "question"),
      message("assistant", "answer"),
    ];
    persistedSession.mask.context = [
      message("system", "pinned system"),
      message("user", "preset user"),
      message("assistant", "preset answer"),
    ];
    persistedSession.memoryPrompt = "";
    persistedSession.lastSummarizeIndex = 0;
    persistedSession.clearContextIndex = 1;
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
    expect(migrated.contextBoundaryAfterMessageId).toBe(
      migrated.messages[2].id,
    );
    expect(migrated.mask.context).toEqual([]);
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
    persistedSession.messages = toLevelOneConversationNodes([
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

  test("records reasoning duration when a reasoning-only stream finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    setSession([]);
    let chatOptions: any;
    apiMocks.chat.mockImplementation((options) => {
      chatOptions = options;
    });

    await useChatStore.getState().onUserInput("question");
    chatOptions.onReasoningUpdate("partial reasoning");
    vi.advanceTimersByTime(65_000);
    await chatOptions.onFinish("", new Response(null, { status: 200 }));

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

  test("generates a node summary once and binds it to the assistant", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "answer"),
    ]);
    const assistantId = session.messages[1].id;
    let finish: ((message: string, response: Response) => void) | undefined;
    apiMocks.chat.mockImplementation((options) => {
      finish = options.onFinish;
    });

    const first = useChatStore
      .getState()
      .generateNodeSummary(session.id, assistantId);
    const second = useChatStore
      .getState()
      .generateNodeSummary(session.id, assistantId);
    expect(apiMocks.chat).toHaveBeenCalledTimes(1);
    finish?.("compact answer", new Response(null, { status: 200 }));
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
    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toHaveLength(4);
    expect(session.summaries).toHaveLength(0);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("does not send an assistant whose user predecessor was deleted", async () => {
    setSession(
      [
        {
          ...message("user", "deleted question"),
          content: "",
          deletedAt: 1,
        },
        message("assistant", "orphan answer"),
      ],
      { sendMemory: true, recentRawNodeCount: 0 },
    );

    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual([]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("context planning does not block on emergency compaction", async () => {
    setSession(
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
    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual([
      expect.objectContaining({ content: "recent question" }),
      expect.objectContaining({ content: "recent answer" }),
    ]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("never sends an oversized recent window when no summary is available", async () => {
    setSession(
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
    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual([]);
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
    session.summaries = [
      {
        id: "stale-summary",
        kind: "segment",
        content: "excluded branch secret",
        sourceEntryIds: ["excluded-m1", messages[0].id],
        sourceDigest: "",
        inputSummaryIds: [],
        stable: true,
      },
    ];

    const requestHistory = await useChatStore
      .getState()
      .getMessagesWithMemory(message("user", "current question"));

    expect(requestHistory.map(getMessageTextContent).join("\n")).not.toContain(
      "excluded branch secret",
    );
  });

  test("regenerates from raw messages when checkpoint inputs were deleted", async () => {
    const messages = [
      message("user", "source question"),
      message("assistant", "source answer"),
    ];
    const session = setSession(messages, { sendMemory: true });
    session.summaries = [
      {
        id: "checkpoint",
        kind: "checkpoint",
        content: "old checkpoint",
        sourceEntryIds: messages.map((item) => item.id),
        sourceDigest: createSummarySourceDigest(messages),
        inputSummaryIds: ["deleted-segment"],
      },
    ];
    let requestText = "";
    apiMocks.chat.mockImplementation((options) => {
      requestText = options.messages.map(getMessageTextContent).join("\n");
      options.onFinish(
        "regenerated checkpoint",
        new Response(null, { status: 200 }),
      );
    });

    await useChatStore.getState().recompressSummary(session.id, "checkpoint");

    const summaries = useChatStore.getState().currentSession().summaries;
    expect(requestText).toContain("source question");
    expect(requestText).toContain("source answer");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).not.toBe("checkpoint");
    expect(summaries[0].content).toBe("regenerated checkpoint");
    expect(summaries[0].inputSummaryIds).toEqual([]);
  });
});
