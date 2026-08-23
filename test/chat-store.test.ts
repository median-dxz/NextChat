import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock("../app/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/client/api")>()),
  ClientApi: class {
    llm: {
      providerName: string;
      chat: (options: unknown) => unknown;
    };

    constructor(providerName: string) {
      this.llm = {
        providerName,
        chat: (options) => apiMocks.chat(options, providerName),
      };
    }
  },
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

import { type ChatSession, DEFAULT_TOPIC, useChatStore } from "../app/store/chat";
import { useAppConfig } from "../app/store/config";
import { StoreKey } from "../app/constant";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import { getLocalAppState, mergeAppState } from "../app/utils/sync";
import { Conversation } from "../app/utils/conversation";

const initialSession = structuredClone(useChatStore.getState().sessions[0]);
const initialConfig = useAppConfig.getState();

function message(
  role: Conversation.Message["role"],
  content: string,
  reasoning?: string,
): Conversation.Message {
  return { id: `${role}-${content}`, date: "", role, content, reasoning };
}

function linearNodes(messages: Conversation.Message[]) {
  let parentId: string | undefined;
  return messages.map((item) => {
    const node = Conversation.createNode({
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
  messages: Conversation.Message[],
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

function setGlobalMemorySession(modelConfig: Partial<ChatSession["mask"]["modelConfig"]> = {}) {
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
  test("updates the latest session without dropping newer conversation nodes", () => {
    const session = setSession([message("user", "before")]);
    const latestAssistant = Conversation.createNode({
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

    useChatStore.getState().updateSession(session.id, (draft) => {
      draft.pendingOutlineDelta = 1;
      draft.conversation = draft.conversation.updateNodeData(session.messages[0].id, (node) => {
        node.content = "after";
      });
    });

    const current = useChatStore.getState().sessions[0];
    expect(current.messages[0].content).toBe("after");
    expect(current.messages[1]).toEqual(latestAssistant);
    expect(current.pendingOutlineDelta).toBe(1);
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

    useChatStore.getState().updateSession(session.id, (draft) => {
      draft.mask.name = "updated mask";
      draft.stat.charCount = 12;
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

  test("does not notify subscribers when a session update is rejected", () => {
    const session = setSession([message("user", "question")]);
    const listener = vi.fn();
    const unsubscribe = useChatStore.subscribe(listener);

    useChatStore.getState().updateSession(session.id, () => false);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  test("retries an assistant without replacing its user node", async () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "old answer"),
      message("user", "later question"),
    ]);
    const [user, assistant, later] = session.messages;
    apiMocks.chat.mockImplementation((options) => {
      options.onFinish("new answer", new Response(null, { status: 200 }));
    });

    await useChatStore.getState().retryMessage(session.id, assistant.id);
    await vi.waitFor(() => expect(useChatStore.getState().hasActiveChatRuns()).toBe(false));

    const retried = useChatStore.getState().currentSession();
    const replacement = retried.messages.find(
      (node) => node.role === "assistant" && node.content === "new answer",
    );
    expect(retried.messages.some((node) => node.id === user.id)).toBe(true);
    expect(retried.messages.some((node) => node.id === assistant.id)).toBe(false);
    expect(replacement).toMatchObject({ parentId: user.id, outlineLevel: 1 });
    expect(retried.messages.find((node) => node.id === later.id)?.parentId).toBe(replacement?.id);
    expect(retried.rootNodeId).toBe(user.id);
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
    const extension = Conversation.createNode({
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
    const original = setSession([message("user", "question"), message("assistant", "answer")]);
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

  test("opens a persisted v3.3 session as a valid v4 conversation", async () => {
    const legacyMask = structuredClone(initialSession.mask) as any;
    legacyMask.modelConfig.sendMemory = true;
    delete legacyMask.modelConfig.enableConversationSummaries;
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
    expect(migrated.pinnedInputs.map((item) => item.content)).toEqual(["pinned system"]);
    expect(migrated.messages.map((item) => item.content)).toEqual([
      "preset user",
      "preset answer",
      "question",
      "answer",
    ]);
    expect(migrated.globalMemory.content).toBe("legacy memory");
    expect(() => Conversation(migrated).validate()).not.toThrow();
  });

  test("recovers interrupted assistant responses after rehydration", async () => {
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
    expect(useChatStore.getState().currentSession().messages[1].content).toContain(
      "empty response",
    );
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
    useChatStore.getState().updateSession(session.id, (draft) => {
      draft.topic = "Manual topic";
    });
    finish?.("Generated topic", new Response(null, { status: 200 }));
    await Promise.resolve();

    expect(useChatStore.getState().currentSession().topic).toBe("Manual topic");
  });

  test("queues concurrent memory updates and feeds each result into the next", async () => {
    const session = setGlobalMemorySession();
    const requests: any[] = [];
    apiMocks.chat.mockImplementation((options) => requests.push(options));

    const first = useChatStore.getState().updateGlobalMemory(session.id);
    const second = useChatStore.getState().updateGlobalMemory(session.id);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0].onFinish("memory one", new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].messages[1]).toEqual({
      role: "system",
      content: "memory one",
    });
    requests[1].onFinish("memory two", new Response(null, { status: 200 }));
    await Promise.all([first, second]);

    expect(useChatStore.getState().currentSession().globalMemory).toMatchObject({
      content: "memory two",
      revision: 2,
    });
  });

  test("uses the configured memory model unless the update selects another", async () => {
    const session = setGlobalMemorySession({
      memoryModel: "configured-model",
      memoryProviderName: "OpenAI",
    });
    const requestedModels: Array<{
      model: string;
      providerName: string;
    }> = [];
    apiMocks.chat.mockImplementation((options, providerName) => {
      requestedModels.push({
        model: options.config.model,
        providerName,
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
    useChatStore.getState().editGlobalMemory(session.id, { content: "manual memory" });
    finish?.("stale generated memory", new Response(null, { status: 200 }));
    await updating;

    expect(useChatStore.getState().currentSession().globalMemory.content).toBe("manual memory");
  });

  test("keeps existing memory when the provider returns only whitespace", async () => {
    const session = setGlobalMemorySession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    apiMocks.chat.mockImplementation((options) =>
      options.onFinish("  ", new Response(null, { status: 200 })),
    );

    await useChatStore.getState().updateGlobalMemory(session.id);

    expect(useChatStore.getState().currentSession().globalMemory).toMatchObject({
      content: "old memory",
      revision: 0,
    });
  });
});
