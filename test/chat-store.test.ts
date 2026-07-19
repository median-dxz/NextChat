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

import {
  type ChatMessage,
  type ChatSession,
  DEFAULT_TOPIC,
  createConversationNode,
  useChatStore,
} from "../app/store/chat";
import { useAppConfig } from "../app/store/config";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";

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

  test("persists reasoning duration through hydration", async () => {
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

    expect(useChatStore.getState().currentSession().messages[0]).toMatchObject({
      reasoning: "persisted reasoning",
      reasoningDurationMs: 65_000,
    });
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
      { ...message("assistant", "", "partial reasoning"), streaming: true },
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

    expect(useChatStore.getState().currentSession().messages[0]).toMatchObject({
      content: "",
      reasoning: "partial reasoning",
      streaming: false,
    });
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

    expect(useChatStore.getState().currentSession().globalMemory).toMatchObject({
      content: "memory two",
      revision: 2,
    });
  });

  test("uses the configured global memory model", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "answer")],
      { memoryModel: "memory-model", memoryProviderName: "OpenAI" },
    );
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    apiMocks.chat.mockImplementation((options) =>
      options.onFinish("new memory", new Response(null, { status: 200 })),
    );

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

  test("allows a one-off global memory model override", async () => {
    const session = setSession(
      [message("user", "question"), message("assistant", "answer")],
      { memoryModel: "configured-model", memoryProviderName: "OpenAI" },
    );
    session.globalMemory = {
      enabled: true,
      prompt: "update memory",
      content: "old memory",
      revision: 0,
    };
    apiMocks.chat.mockImplementation((options) =>
      options.onFinish("new memory", new Response(null, { status: 200 })),
    );

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
});
