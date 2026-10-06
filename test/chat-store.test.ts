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

import { DEFAULT_TOPIC, useChatStore } from "../app/store/chat";
import { useAppConfig } from "../app/store/config";
import { StoreKey } from "../app/constant";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import {
  deserializeAppState,
  getLocalAppState,
  mergeAppState,
  serializeAppState,
} from "../app/utils/sync";
import { Conversation } from "../app/utils/conversation";
import { generatedSummary } from "./fixtures/conversation";

const initialSession = structuredClone(useChatStore.getState().sessions[0]);
const initialConfig = useAppConfig.getState();

function message(role: Conversation.Message["role"], content: string): Conversation.Message {
  return Conversation.createMessage({
    id: `${role}-${content}`,
    date: "",
    role,
    content,
  });
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

function setSession(messages: Conversation.Message[]) {
  const session = structuredClone(initialSession);
  session.messages = linearNodes(messages);
  session.rootNodeId = session.messages[0]?.id;
  session.activeCursorId = session.messages.at(-1)?.id;
  session.topic = DEFAULT_TOPIC;
  session.mask.modelConfig = {
    ...session.mask.modelConfig,
    enableInjectSystemPrompts: false,
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

function setGlobalMemorySession() {
  const session = setSession([message("user", "question"), message("assistant", "answer")]);
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
  test("updates the latest graph and metadata without mutating prior snapshots", () => {
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
              topic: "latest topic",
              messages: [...item.messages, latestAssistant],
              activeCursorId: latestAssistant.id,
            }
          : item,
      ),
    }));
    const previous = useChatStore.getState().currentSession();

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
    expect(current.topic).toBe("latest topic");
    expect(previous.messages[0].content).toBe("before");

    useChatStore.getState().updateSession(session.id, (draft) => {
      draft.mask.name = "updated mask";
      draft.stat.charCount = 12;
    });

    const updated = useChatStore.getState().currentSession();
    expect(updated.topic).toBe("latest topic");
    expect(updated.mask.name).toBe("updated mask");
    expect(updated.stat.charCount).toBe(12);
    expect(updated.messages).toBe(current.messages);
    expect(current.mask.name).not.toBe("updated mask");
    expect(current.stat.charCount).toBe(0);
  });

  test("does not notify subscribers when a session update is rejected", () => {
    const session = setSession([message("user", "question")]);
    const listener = vi.fn();
    const unsubscribe = useChatStore.subscribe(listener);

    useChatStore.getState().updateSession(session.id, () => false);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
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

  test("opens a persisted v3.3 session as a valid v4.1 conversation", async () => {
    const legacyMask = structuredClone(initialSession.mask) as any;
    legacyMask.modelConfig.sendMemory = true;
    delete legacyMask.modelConfig.enableConversationSummaries;
    legacyMask.context = [
      { id: "preset-system", date: "", role: "system", content: "pinned system" },
      { id: "preset-user", date: "", role: "user", content: "preset user" },
      { id: "preset-assistant", date: "", role: "assistant", content: "preset answer" },
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
        { id: "legacy-user", date: "", role: "user", content: "question" },
        { id: "legacy-assistant", date: "", role: "assistant", content: "answer" },
      ],
      stat: structuredClone(initialSession.stat),
      lastUpdate: initialSession.lastUpdate,
      lastSummarizeIndex: 2,
      clearContextIndex: 1,
      mask: legacyMask,
    };
    mockPersistedChatState(3.3, [persistedSession]);
    const write = vi.spyOn(indexedDBStorage, "setItem").mockResolvedValue();

    await useChatStore.persist.rehydrate();

    const migrated = useChatStore.getState().currentSession();
    expect(JSON.parse(write.mock.calls.at(-1)![1]).version).toBe(4.1);
    expect(migrated.pinnedInputs.map((item) => [item.id, item.role, item.content])).toEqual(
      legacyMask.context.map((item: Conversation.SerializedMessage) => [
        item.id,
        item.role,
        item.content,
      ]),
    );
    expect(migrated.messages.map((item) => item.content)).toEqual(["question", "answer"]);
    expect(migrated.globalMemory).toMatchObject({
      enabled: true,
      prompt: "",
      content: "legacy memory",
    });
    expect(migrated).not.toHaveProperty("clearContextIndex");
    expect(migrated.mask.context).toEqual(legacyMask.context);
    expect(() => Conversation(migrated).validate()).not.toThrow();
  });

  test("round-trips a branched conversation without changing its live state", async () => {
    const session = setSession([message("user", "question"), message("assistant", "partial")]);
    const [root, answer] = session.messages;
    answer.nodeSummaries = {
      segment: generatedSummary([root, answer], "summary", "user-edited"),
    };
    answer.streaming = true;
    answer.reasoning = "partial reasoning";
    answer.tools = [
      { id: "tool", function: { name: "lookup" }, content: "result", isError: false },
    ];
    answer.audio_url = "/audio.wav";
    const branch = Conversation.createNode({
      id: "branch",
      role: "assistant",
      content: "branch answer",
      streaming: true,
      parentId: root.id,
      outlineLevel: 2,
    });
    root.activeBranchRootId = branch.id;
    session.messages.push(branch);
    session.activeCursorId = branch.id;
    session.pinnedInputs = [Conversation.createMessage({ role: "system", content: "pinned" })];
    const before = structuredClone(session);
    const write = vi.spyOn(indexedDBStorage, "setItem").mockResolvedValue();
    useChatStore.setState({ sessions: [session] });
    const saved = write.mock.calls.at(-1)![1];
    const savedSession = JSON.parse(saved).state.sessions[0];
    for (const item of [...savedSession.messages, ...savedSession.pinnedInputs]) {
      expect(item).not.toHaveProperty("streaming");
    }
    expect(useChatStore.getState().currentSession()).toEqual(before);
    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(saved);
    setSession([]);
    await useChatStore.persist.rehydrate();
    const restored = useChatStore.getState().currentSession();
    expect(() => Conversation(restored).validate()).not.toThrow();
    expect(restored).toEqual({
      ...before,
      messages: before.messages.map((node) => ({ ...node, streaming: false })),
    });
  });

  test("restores incoming backup data while preserving a local active response during merge", () => {
    const session = setSession([
      message("user", "question"),
      message("assistant", "local partial"),
    ]);
    session.messages[1].streaming = true;
    const local = getLocalAppState();
    const remote = structuredClone(local);
    remote[StoreKey.Chat].sessions[0].messages[1].content = "remote conflict";
    const added = Conversation.createNode({
      id: "remote-extension",
      role: "user",
      content: "remote question",
      parentId: session.messages[1].id,
      outlineLevel: 1,
    });
    remote[StoreKey.Chat].sessions[0].messages.push(added);
    const json = serializeAppState(remote);
    expect(JSON.parse(json)[StoreKey.Chat].sessions[0].messages[1]).not.toHaveProperty("streaming");
    mergeAppState(local, deserializeAppState(json));
    const merged = local[StoreKey.Chat].sessions[0];
    expect(merged.messages).toEqual([...session.messages, added]);
    expect(() => Conversation(merged).validate()).not.toThrow();
  });

  test("does not overwrite a title edited during generation", async () => {
    const session = setSession([message("user", "question")]);
    session.topic = "Existing topic";
    apiMocks.chat.mockImplementation(() => {});

    useChatStore.getState().generateSessionTitle(session, true);
    useChatStore.getState().updateSession(session.id, (draft) => {
      draft.topic = "Manual topic";
    });
    expect(apiMocks.chat).toHaveBeenCalledOnce();
    apiMocks.chat.mock.calls[0][0].onFinish("Generated topic", new Response(null, { status: 200 }));
    // generateSessionTitle returns void; let the request and writeback microtasks finish.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

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
});
