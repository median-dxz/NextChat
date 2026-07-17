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

  test("compacts all old turns when the recent history count is zero", async () => {
    const session = setSession(
      [
        message("user", "old question 1"),
        message("assistant", "old answer 1"),
        message("user", "old question 2"),
        message("assistant", "old answer 2"),
      ],
      {
        sendMemory: true,
        historyMessageCount: 0,
        compressMessageLengthThreshold: 0,
      },
    );
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish(
        "complete history summary",
        new Response(null, { status: 200 }),
      );
    });

    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("complete history summary"),
      }),
    ]);
    expect(session.summaries).toHaveLength(1);
  });

  test("preserves an assistant when its deleted predecessor is not migrated", async () => {
    setSession(
      [
        {
          ...message("user", "deleted question"),
          content: "",
          deletedAt: 1,
        },
        message("assistant", "orphan answer"),
      ],
      { sendMemory: true, historyMessageCount: 0 },
    );

    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual([
      expect.objectContaining({ role: "assistant", content: "orphan answer" }),
    ]);
    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("emergency compaction progresses past one oversized old turn", async () => {
    const session = setSession(
      [
        message("user", "a".repeat(4_000)),
        message("assistant", "b".repeat(4_000)),
        message("user", "recent question"),
        message("assistant", "recent answer"),
      ],
      {
        sendMemory: true,
        historyMessageCount: 2,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish("old turn summary", new Response(null, { status: 200 }));
    });

    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("old turn summary"),
        }),
      ]),
    );
    expect(session.summaries).toHaveLength(1);
  });

  test("propagates the summary model error during blocking compaction", async () => {
    setSession(
      [
        message("user", "a".repeat(4_000)),
        message("assistant", "b".repeat(4_000)),
      ],
      {
        sendMemory: true,
        historyMessageCount: 1,
        contextWindowTokens: 1_024,
        max_tokens: 128,
      },
    );
    apiMocks.chat.mockImplementation((options) => {
      options.onError(new Error("summary model unavailable"));
    });

    await expect(
      useChatStore
        .getState()
        .getMessagesWithMemory(message("user", "current question")),
    ).rejects.toThrow("summary model unavailable");
  });

  test("replans after an existing summary job without forcing an extra request", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "answer")],
      {
        sendMemory: true,
        historyMessageCount: 0,
        compressMessageLengthThreshold: 0,
      },
    );
    let finishSummary: (() => void) | undefined;
    apiMocks.chat.mockImplementation((options) => {
      finishSummary = () =>
        options.onFinish("summary", new Response(null, { status: 200 }));
    });

    const background = useChatStore
      .getState()
      .maintainSummaries(session.id, false);
    const waitingForce = useChatStore
      .getState()
      .maintainSummaries(session.id, true);
    finishSummary?.();
    await Promise.all([background, waitingForce]);

    expect(apiMocks.chat).toHaveBeenCalledTimes(1);
  });

  test("excludes reasoning from title and history compression requests", async () => {
    const session = setSession(
      [
        message(
          "user",
          "A sufficiently long user question for automatic title generation. ".repeat(
            8,
          ),
        ),
        message("assistant", "concise final answer", "private reasoning"),
      ],
      {
        sendMemory: true,
        compressMessageLengthThreshold: 0,
        historyMessageCount: 0,
        max_tokens: 4000,
      },
    );
    useAppConfig.setState({ enableAutoGenerateTitle: true });

    useChatStore.getState().generateSessionTitle(session);
    const maintenance = useChatStore
      .getState()
      .maintainSummaries(session.id, false);

    expect(apiMocks.chat).toHaveBeenCalledTimes(2);
    for (const [options] of apiMocks.chat.mock.calls) {
      const requestText = options.messages
        .map(getMessageTextContent)
        .join("\n");
      expect(requestText).not.toContain("private reasoning");
      options.onFinish("generated result", new Response(null, { status: 200 }));
    }
    await maintenance;
  });

  test("does not let reasoning length affect the compression threshold", async () => {
    const session = setSession(
      [
        message("user", "short question"),
        message("assistant", "short answer", "x".repeat(20_000)),
      ],
      {
        sendMemory: true,
        historyMessageCount: 0,
        compressMessageLengthThreshold: 100,
        max_tokens: 4000,
      },
    );

    await useChatStore.getState().maintainSummaries(session.id, false);

    expect(apiMocks.chat).not.toHaveBeenCalled();
  });

  test("creates a checkpoint without superseding its segment inputs", async () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `message-${index + 1}`),
    );
    const session = setSession(messages, {
      sendMemory: true,
      historyMessageCount: 0,
      compressMessageLengthThreshold: 0,
    });
    session.summaries = Array.from({ length: 4 }, (_, index) => {
      const sourceMessages = messages.slice(index * 2, index * 2 + 2);
      return {
        id: `segment-${index + 1}`,
        kind: "segment",
        content: `segment ${index + 1}`,
        sourceEntryIds: sourceMessages.map((item) => item.id),
        sourceDigest: createSummarySourceDigest(sourceMessages),
        inputSummaryIds: [],
      } satisfies ConversationSummary;
    });
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish(
        "global checkpoint",
        new Response(null, { status: 200 }),
      );
    });

    await useChatStore.getState().maintainSummaries(session.id, true);

    const summaries = useChatStore.getState().currentSession().summaries;
    expect(summaries.slice(0, 4)).toHaveLength(4);
    expect(summaries.at(-1)).toEqual(
      expect.objectContaining({
        kind: "checkpoint",
        content: "global checkpoint",
        inputSummaryIds: summaries.slice(0, 4).map((item) => item.id),
      }),
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
