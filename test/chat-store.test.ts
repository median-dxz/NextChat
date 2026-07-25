import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock("../app/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/client/api")>()),
  getClientApi: () => ({ llm: { chat: apiMocks.chat } }),
}));

vi.mock("../app/mcp/actions", () => ({
  executeMcpAction: vi.fn(),
  getAllTools: vi.fn().mockResolvedValue([]),
  isMcpEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../app/store/prompt", () => ({
  usePromptStore: {
    getState: () => ({ prompts: {} }),
    setState: vi.fn(),
  },
}));

import {
  type ChatMessage,
  type ChatSession,
  DEFAULT_TOPIC,
  createConversationNode,
  useChatStore,
} from "../app/store/chat";
import { useAppConfig } from "../app/store/config";
import { StoreKey } from "../app/constant";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import { getLocalAppState, mergeAppState } from "../app/utils/sync";

const initialSession = structuredClone(useChatStore.getState().sessions[0]);
const initialConfig = useAppConfig.getState();

function message(
  role: ChatMessage["role"],
  content: string,
  reasoning?: string,
): ChatMessage {
  return { id: `${role}-${content}`, date: "", role, content, reasoning };
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

function mockPersistedChatState(version: number, sessions: unknown[]) {
  vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
    JSON.stringify({
      state: {
        sessions,
        currentSessionIndex: 0,
        lastInput: "",
        _hasHydrated: true,
      },
      version,
    }),
  );
}

function setGlobalMemorySession(
  modelConfig: Partial<ChatSession["mask"]["modelConfig"]> = {},
) {
  const session = setSession(
    [message("user", "question"), message("assistant", "answer")],
    modelConfig,
  );
  session.globalMemory = {
    enabled: true,
    prompt: "update memory",
    content: "old memory",
    revision: 0,
  };
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
  useAppConfig.setState({ enableAutoGenerateTitle: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAppConfig.setState(initialConfig);
});

describe("chat store persistence and owned lifecycles", () => {
  test("commits conversation and its session patch from the latest snapshot", () => {
    const session = setSession([message("user", "before")]);
    const latestAssistant = createConversationNode({
      ...message("assistant", "latest"),
      parentId: session.messages[0].id,
      outlineLevel: 1,
    });
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === session.id
          ? {
              ...item,
              messages: [...item.messages, latestAssistant],
              activeCursorId: latestAssistant.id,
            }
          : item,
      ),
    }));

    const previousSessions = useChatStore.getState().sessions;
    const previousMessages = useChatStore.getState().currentSession().messages;
    const listener = vi.fn();
    const unsubscribe = useChatStore.subscribe(listener);

    useChatStore.getState().updateConversation(
      session.id,
      (conversation) =>
        conversation.updateNodeData(session.messages[0].id, (node) => {
          node.content = "after";
        }),
      {
        pendingOutlineDelta: 1,
        globalMemory: {
          enabled: true,
          prompt: "remember",
          content: "memory",
          revision: 1,
        },
      },
    );
    unsubscribe();

    const current = useChatStore.getState().sessions[0];
    expect(listener).toHaveBeenCalledTimes(1);
    expect(current.messages[0].content).toBe("after");
    expect(current.messages[1]).toEqual(latestAssistant);
    expect(current.pendingOutlineDelta).toBe(1);
    expect(current.globalMemory.content).toBe("memory");
    expect(useChatStore.getState().sessions).not.toBe(previousSessions);
    expect(current.messages).not.toBe(previousMessages);
  });

  test("updates metadata from the latest session without copying messages", () => {
    const session = setSession([message("user", "question")]);
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === session.id ? { ...item, topic: "latest topic" } : item,
      ),
    }));
    const previousSession = useChatStore.getState().currentSession();
    const previousSessions = useChatStore.getState().sessions;
    const previousMessages = previousSession.messages;
    const previousMask = previousSession.mask;

    useChatStore.getState().updateSessionMetadata(session.id, (metadata) => {
      metadata.mask.name = "updated mask";
      metadata.stat.charCount = 12;
    });

    const current = useChatStore.getState().currentSession();
    expect(current.topic).toBe("latest topic");
    expect(current.mask.name).toBe("updated mask");
    expect(current.stat.charCount).toBe(12);
    expect(current.messages).toBe(previousMessages);
    expect(current.mask).not.toBe(previousMask);
    expect(previousMask.name).not.toBe("updated mask");
    expect(useChatStore.getState().sessions).not.toBe(previousSessions);
  });

  test("keeps invalid remote conversations out while merging other sessions", () => {
    const template = setSession([message("user", "valid")]);
    const local = getLocalAppState();
    const remote = structuredClone(local);
    const invalid = structuredClone(template);
    invalid.id = "invalid-remote";
    invalid.messages[0].parentId = "missing-parent";
    const valid = structuredClone(template);
    valid.id = "valid-remote";
    const extension = createConversationNode({
      ...message("assistant", "remote extension"),
      parentId: template.messages[0].id,
      outlineLevel: 1,
    });
    const merged = structuredClone(template);
    merged.messages[0].content = "remote conflict";
    merged.messages.push(extension);
    remote[StoreKey.Chat].sessions = [invalid, valid, merged];
    vi.spyOn(console, "warn").mockImplementation(() => {});

    mergeAppState(local, remote);

    const ids = local[StoreKey.Chat].sessions.map((session) => session.id);
    expect(ids).toContain("valid-remote");
    expect(ids).not.toContain("invalid-remote");
    const localSession = local[StoreKey.Chat].sessions.find(
      (session) => session.id === template.id,
    )!;
    expect(localSession.messages.map((node) => node.content)).toEqual([
      "valid",
      "remote extension",
    ]);
  });

  test("forks graph nodes and remaps session references", () => {
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

  test("migrates v3.3 sessions into graph context and global memory", async () => {
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
      messages: [message("user", "question"), message("assistant", "answer")],
      stat: structuredClone(initialSession.stat),
      lastUpdate: initialSession.lastUpdate,
      lastSummarizeIndex: 2,
      clearContextIndex: 1,
      mask: legacyMask,
    };
    mockPersistedChatState(3.3, [persistedSession]);

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

  test("preserves an intentionally empty graph cursor during hydration", async () => {
    const persistedSession = structuredClone(initialSession);
    persistedSession.messages = linearNodes([
      message("user", "root"),
      message("assistant", "tail"),
    ]);
    persistedSession.rootNodeId = persistedSession.messages[0].id;
    persistedSession.activeCursorId = undefined;
    mockPersistedChatState(4, [persistedSession]);

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
        reasoningDurationMs: 65_000,
        streaming: true,
      },
      { ...message("assistant", ""), id: "empty-stream", streaming: true },
      {
        ...message("assistant", ""),
        id: "stale-empty",
        date: "2000-01-01T00:00:00.000Z",
      },
    ];
    mockPersistedChatState(4, [persistedSession]);

    setSession([]);
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().currentSession().messages[0]).toMatchObject({
      content: "",
      reasoning: "partial reasoning",
      reasoningDurationMs: 65_000,
      streaming: false,
    });
    expect(useChatStore.getState().currentSession().messages[1]).toMatchObject({
      isError: true,
      streaming: false,
    });
    expect(
      useChatStore.getState().currentSession().messages[1].content,
    ).toContain("empty response");
    expect(useChatStore.getState().currentSession().messages[2]).toMatchObject({
      isError: true,
      streaming: false,
    });
  });

  test("does not overwrite a title edited during generation", async () => {
    const session = setSession([message("user", "question")]);
    session.topic = "Existing topic";
    let finish: ((message: string, response: Response) => void) | undefined;
    apiMocks.chat.mockImplementation((options) => {
      finish = options.onFinish;
    });

    useChatStore.getState().generateSessionTitle(session, true);
    useChatStore.getState().updateSessionMetadata(session.id, (metadata) => {
      metadata.topic = "Manual topic";
    });
    finish?.("Generated topic", new Response(null, { status: 200 }));
    await Promise.resolve();

    expect(useChatStore.getState().currentSession().topic).toBe("Manual topic");
  });

  test("serializes global memory updates", async () => {
    const session = setGlobalMemorySession();
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

  test("resolves configured and one-off global memory models", async () => {
    const session = setGlobalMemorySession({
      memoryModel: "configured-model",
      memoryProviderName: "OpenAI",
    });
    const requestedModels: Array<{
      model: string;
      providerName: string;
    }> = [];
    apiMocks.chat.mockImplementation((options) => {
      requestedModels.push({
        model: options.config.model,
        providerName: options.config.providerName,
      });
      options.onFinish("new memory", new Response(null, { status: 200 }));
    });

    await useChatStore.getState().updateGlobalMemory(session.id);
    await useChatStore.getState().updateGlobalMemory(session.id, undefined, {
      model: "temporary-model",
      providerName: "Google",
    });

    expect(requestedModels).toEqual([
      {
        model: "configured-model",
        providerName: "OpenAI",
      },
      {
        model: "temporary-model",
        providerName: "Google",
      },
    ]);
  });

  test("does not overwrite a manual global memory edit", async () => {
    const session = setGlobalMemorySession();
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

  test("does not commit an empty global memory response", async () => {
    const session = setGlobalMemorySession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    apiMocks.chat.mockImplementation((options) =>
      options.onFinish("  ", new Response(null, { status: 200 })),
    );

    await useChatStore.getState().updateGlobalMemory(session.id);

    expect(useChatStore.getState().currentSession().globalMemory).toMatchObject(
      {
        content: "old memory",
        revision: 0,
      },
    );
  });
});
