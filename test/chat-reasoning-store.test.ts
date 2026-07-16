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
  session.messages = messages;
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

describe("structured reasoning in chat state", () => {
  test("persists reasoning and restores it during hydration", async () => {
    const persistedSession = structuredClone(initialSession);
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

  test("excludes reasoning from title and history compression requests", () => {
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
        historyMessageCount: 10,
        max_tokens: 4000,
      },
    );
    useAppConfig.setState({ enableAutoGenerateTitle: true });

    useChatStore.getState().summarizeSession(false, session);

    expect(apiMocks.chat).toHaveBeenCalledTimes(2);
    for (const [options] of apiMocks.chat.mock.calls) {
      const requestText = options.messages
        .map(getMessageTextContent)
        .join("\n");
      expect(requestText).not.toContain("private reasoning");
    }
  });

  test("does not let reasoning length affect the compression threshold", () => {
    const session = setSession(
      [message("assistant", "short answer", "x".repeat(20_000))],
      {
        sendMemory: true,
        compressMessageLengthThreshold: 100,
        max_tokens: 4000,
      },
    );

    useChatStore.getState().summarizeSession(false, session);

    expect(apiMocks.chat).not.toHaveBeenCalled();
  });
});
