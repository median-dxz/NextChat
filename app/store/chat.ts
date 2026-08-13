import { nanoid } from "nanoid";

import {
  getMessageTextContent,
  isDalle3,
  safeLocalStorage,
  trimTopic,
} from "../utils";
import { requestText, toModelInputMessages } from "../client/request-text";
import { showToast } from "../components/ui-lib";
import { getClientApi } from "../client/api";

import { executeMcpAction, isMcpEnabled } from "@/app/mcp/actions";
import { indexedDBStorage } from "@/app/utils/indexedDB-storage";

import {
  DEEPSEEK_SUMMARIZE_MODEL,
  GEMINI_SUMMARIZE_MODEL,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
} from "../constant";
import Locale from "../locales";
import { extractMcpJson, isMcpJson } from "../mcp/utils";
import { deepClone } from "../utils/clone";
import type {
  ConversationGraphState,
  GlobalMemory,
} from "../utils/conversation";
import {
  Conversation,
  createMessage,
  type ChatMessage,
  type ConversationApi,
  type ConversationNode,
  type NodeSummaryKind,
} from "../utils/conversation";
import { prettyObject } from "../utils/format";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import { useAccessStore } from "./access";
import {
  createChatOrchestrator,
  type ChatOrchestrator,
} from "./chat-orchestrator";
import { useAppConfig } from "./config";
import { createEmptyMask, Mask } from "./mask";
import {
  createSummaryMaintenance,
  type SummaryMaintenance,
} from "./summary-maintenance";

export { createConversationNode, createMessage } from "../utils/conversation";
export type {
  ChatMessage,
  ChatMessageTool,
  ConversationNode,
} from "../utils/conversation";

const localStorage = safeLocalStorage();
const globalMemoryJobs = new Map<string, Promise<void>>();

interface MemoryModelOverride {
  model: string;
  providerName: string;
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession extends ConversationGraphState {
  id: string;
  topic: string;

  pendingOutlineDelta?: -1 | 1;
  pinnedInputs: ChatMessage[];
  globalMemory: GlobalMemory;
  stat: ChatStat;
  lastUpdate: number;

  mask: Mask;
}

type ChatSessionMetadata = Omit<
  ChatSession,
  keyof ConversationGraphState | "id"
>;

type ConversationSessionPatch = Partial<
  Pick<ChatSessionMetadata, "pendingOutlineDelta" | "globalMemory">
>;

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    messages: [],
    pinnedInputs: [],
    globalMemory: Conversation.createMemory(),
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    mask: createEmptyMask(),
  };
}

function migrateMessagesToConversationNodes(
  messages: ChatMessage[],
): ConversationNode[] {
  let parentId: string | undefined;
  return messages.map((message) => {
    const node: ConversationNode = {
      ...message,
      parentId,
      outlineLevel: 1,
      activeBranchRootId: undefined,
    };
    parentId = node.id;
    return node;
  });
}

function materializeMaskContext(session: ChatSession) {
  const context = session.mask.context.slice();
  const pinnedInputs = context.filter((message) => message.role === "system");
  const startingMessages = context.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const nodes = migrateMessagesToConversationNodes(startingMessages);
  session.pinnedInputs = pinnedInputs.map((message) => ({
    ...message,
    outlineLevel: 0,
  }));
  session.messages = nodes;
  session.rootNodeId = nodes[0]?.id;
  session.activeCursorId = nodes.at(-1)?.id;
  session.mask = { ...session.mask, context: [] };
}

function migrateSessionToConversation(session: any) {
  const oldMessages = Array.isArray(session.messages) ? session.messages : [];
  const maskContext = Array.isArray(session.mask?.context)
    ? session.mask.context
    : [];
  const presetNodes = maskContext.filter(
    (message: ChatMessage) =>
      message.role === "user" || message.role === "assistant",
  );
  const nodes = migrateMessagesToConversationNodes([
    ...presetNodes,
    ...oldMessages,
  ]);
  session.messages = nodes;
  session.rootNodeId = nodes[0]?.id;
  session.activeCursorId = nodes.at(-1)?.id;
  session.pinnedInputs = maskContext
    .filter((message: ChatMessage) => message.role === "system")
    .map((message: ChatMessage) => ({ ...message, outlineLevel: 0 }));
  const oldMemory = String(session.memoryPrompt ?? "").trim();
  session.globalMemory = oldMemory
    ? {
        ...Conversation.createMemory(),
        enabled: true,
        content: oldMemory,
      }
    : Conversation.createMemory();
  session.mask.context = [];
  session.mask.modelConfig.enableConversationSummaries =
    session.mask.modelConfig.sendMemory ?? true;
  session.mask.modelConfig.contextWindowTokens ??= 32_000;
  session.mask.modelConfig.memoryModel ??= "";
  session.mask.modelConfig.memoryProviderName ??= "";
  session.mask.modelConfig.titleModel ??= "";
  session.mask.modelConfig.titleProviderName ??= "";
  session.mask.modelConfig.recentRawNodeCount =
    session.mask.modelConfig.historyMessageCount ?? 4;
  session.mask.modelConfig.segmentTargetSourceTokens =
    session.mask.modelConfig.compressMessageLengthThreshold ?? 1000;
  session.mask.modelConfig.segmentMaxSourceNodes = 16;
  session.mask.modelConfig.checkpointTargetSegments = 4;
  session.mask.modelConfig.checkpointMergeTargetTokens = Math.max(
    1000,
    session.mask.modelConfig.segmentTargetSourceTokens,
  );
  delete session.mask.modelConfig.historyMessageCount;
  delete session.mask.modelConfig.compressMessageLengthThreshold;
  delete session.mask.modelConfig.sendMemory;
  delete session.memoryPrompt;
  delete session.lastSummarizeIndex;
  delete session.clearContextIndex;
  Conversation(session).validate();
}

function getSummarizeModel(
  currentModel: string,
  providerName: string,
): [model: string, providerName: string] {
  // if it is using gpt-* models, force to use 4o-mini to summarize
  if (currentModel.startsWith("gpt") || currentModel.startsWith("chatgpt")) {
    const configStore = useAppConfig.getState();
    const accessStore = useAccessStore.getState();
    const allModel = collectModelsWithDefaultModel(
      configStore.models,
      [configStore.customModels, accessStore.customModels].join(","),
      accessStore.defaultModel,
    );
    const summarizeModel = allModel.find(
      (m) => m.name === SUMMARIZE_MODEL && m.available,
    );
    if (summarizeModel) {
      return [
        summarizeModel.name,
        summarizeModel.provider?.providerName as string,
      ];
    }
  }
  if (currentModel.startsWith("gemini")) {
    return [GEMINI_SUMMARIZE_MODEL, ServiceProvider.Google];
  } else if (currentModel.startsWith("deepseek-")) {
    return [DEEPSEEK_SUMMARIZE_MODEL, ServiceProvider.DeepSeek];
  }

  return [currentModel, providerName];
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) => pre + estimateTokenLength(getMessageTextContent(cur)),
    0,
  );
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  currentSessionIndex: 0,
  lastInput: "",
};

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    let chatOrchestrator: ChatOrchestrator;
    let summaryMaintenance: SummaryMaintenance;

    function updateSession(
      sessionId: string,
      updater: (session: ChatSession) => ChatSession | undefined,
    ) {
      set((state) => {
        const index = state.sessions.findIndex(
          (session) => session.id === sessionId,
        );
        if (index < 0) return state;

        const current = state.sessions[index];
        const next = updater(current);
        if (!next || next === current) return state;

        const sessions = state.sessions.slice();
        sessions[index] = next;
        return { sessions };
      });
    }

    const methods = {
      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 克隆消息图并重建节点 ID
        const { conversation } = Conversation(currentSession).clone(nanoid);
        Object.assign(newSession, conversation.state);
        newSession.pinnedInputs = currentSession.pinnedInputs.map(
          (message) => ({
            ...message,
            id: nanoid(),
          }),
        );
        newSession.globalMemory = { ...currentSession.globalMemory };
        // Summaries are derived from message IDs, so the fork rebuilds them.
        newSession.mask = {
          ...currentSession.mask,
          modelConfig: {
            ...currentSession.mask.modelConfig,
          },
        };

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [newSession, ...state.sessions],
        }));
      },

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask?: Mask) {
        const session = createEmptySession();

        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
          session.topic = mask.name;
          materializeMaskContext(session);
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      nextSession(delta: number) {
        const n = get().sessions.length;
        const limit = (x: number) => (x + n) % n;
        const i = get().currentSessionIndex;
        get().selectSession(limit(i + delta));
      },

      deleteSession(index: number) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);

        if (!deletedSession) return;

        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
        }));

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onUserInput(
        content: string,
        attachImages?: string[],
        isMcpResponse?: boolean,
      ) {
        return chatOrchestrator.start({
          sessionId: get().currentSession().id,
          content,
          attachImages,
          isMcpResponse,
        });
      },

      hasActiveChatRuns() {
        return chatOrchestrator.activeRuns().length > 0;
      },

      cancelChatRun(sessionId: string, assistantNodeId: string) {
        chatOrchestrator.cancel(sessionId, assistantNodeId);
      },

      cancelAllChatRuns() {
        chatOrchestrator.cancelAll();
      },

      resetSession(session: ChatSession) {
        get().updateConversation(
          session.id,
          () => Conversation({ messages: [] }),
          {
            pendingOutlineDelta: undefined,
            globalMemory: Conversation.createMemory(),
          },
        );
      },

      generateSessionTitle(
        targetSession: ChatSession,
        refreshTitle: boolean = false,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        // skip summarize when using dalle3?
        if (isDalle3(modelConfig.model)) {
          return;
        }

        const [titleModel, titleProviderName] = modelConfig.titleModel
          ? [modelConfig.titleModel, modelConfig.titleProviderName]
          : getSummarizeModel(
              session.mask.modelConfig.model,
              session.mask.modelConfig.providerName,
            );
        // remove error messages if any
        const messages = Conversation(session).projectToCursor();

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= SUMMARIZE_MIN_LEN) ||
          refreshTitle
        ) {
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.recentRawNodeCount,
          );
          const topicMessages: ChatMessage[] = [
            ...messages.slice(
              startIndex < messages.length ? startIndex : messages.length - 1,
              messages.length,
            ),
            createMessage({
              role: "user",
              content: Locale.Store.Prompt.Topic,
            }),
          ];
          const topicAtRequest = session.topic;
          void requestText(
            getClientApi(titleProviderName as ServiceProvider),
            toModelInputMessages(topicMessages),
            {
              ...modelConfig,
              model: titleModel,
              providerName: titleProviderName,
            },
            session.mask.plugin ?? [],
          )
            .then((message) => {
              get().updateSessionMetadata(session.id, (metadata) => {
                if (metadata.topic !== topicAtRequest) return false;
                metadata.topic =
                  message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC;
              });
            })
            .catch((error) => console.error("[Title]", error));
        }
      },

      async generateNodeSummary(
        sessionId: string,
        nodeId: string,
        force = false,
        onlyKind?: NodeSummaryKind,
      ): Promise<void> {
        return summaryMaintenance.maintain({
          sessionId,
          targetNodeId: nodeId,
          force,
          onlyKind,
        });
      },

      deleteNodeSummary(
        sessionId: string,
        nodeId: string,
        kind: NodeSummaryKind,
      ) {
        get().updateConversation(sessionId, (conversation) =>
          conversation.summaries.findNode(nodeId)?.remove(kind),
        );
      },

      editGlobalMemory(
        sessionId: string,
        update: Partial<Pick<GlobalMemory, "enabled" | "prompt" | "content">>,
      ) {
        get().updateSessionMetadata(sessionId, (draft) => {
          Object.assign(draft.globalMemory, update);
          draft.globalMemory.revision += 1;
        });
      },

      async updateGlobalMemory(
        sessionId: string,
        prompt?: string,
        modelOverride?: MemoryModelOverride,
      ) {
        const previous = globalMemoryJobs.get(sessionId) ?? Promise.resolve();
        const execution = previous
          .catch(() => undefined)
          .then(async () => {
            const session = get().sessions.find(
              (item) => item.id === sessionId,
            );
            if (!session || !session.globalMemory.enabled) return;
            const memoryInstruction = (
              prompt ?? session.globalMemory.prompt
            ).trim();
            if (!memoryInstruction) return;

            const projection = Conversation(session).projectToCursor();
            const assistant = projection
              .slice()
              .reverse()
              .find(
                (node) =>
                  node.role === "assistant" && !node.streaming && !node.isError,
              );
            const user = assistant?.parentId
              ? session.messages.find((node) => node.id === assistant.parentId)
              : undefined;
            if (!assistant || !user || user.role !== "user") return;

            const revision = session.globalMemory.revision;
            const modelConfig = session.mask.modelConfig;
            const [model, providerName] = modelOverride
              ? [modelOverride.model, modelOverride.providerName]
              : modelConfig.memoryModel
                ? [modelConfig.memoryModel, modelConfig.memoryProviderName]
                : modelConfig.compressModel
                  ? [
                      modelConfig.compressModel,
                      modelConfig.compressProviderName,
                    ]
                  : getSummarizeModel(
                      modelConfig.model,
                      modelConfig.providerName,
                    );
            const messages: ChatMessage[] = [
              createMessage({
                role: "system",
                content: memoryInstruction,
                date: "",
              }),
              createMessage({
                role: "system",
                content: session.globalMemory.content,
                date: "",
              }),
              user,
              assistant,
            ];
            const content = await requestText(
              getClientApi(providerName as ServiceProvider),
              toModelInputMessages(messages),
              {
                ...modelConfig,
                model,
                providerName,
              },
              session.mask.plugin ?? [],
            );
            if (!content) {
              throw new Error(
                `Global memory request returned empty content (${providerName}/${model})`,
              );
            }
            const current = get().sessions.find(
              (item) => item.id === sessionId,
            );
            if (!current || current.globalMemory.revision !== revision) return;
            get().updateSessionMetadata(sessionId, (draft) => {
              if (draft.globalMemory.revision !== revision) return false;
              draft.globalMemory.content = content;
              draft.globalMemory.revision += 1;
            });
          });
        globalMemoryJobs.set(sessionId, execution);
        return execution
          .catch((error) => console.error("[Global Memory]", error))
          .finally(() => {
            if (globalMemoryJobs.get(sessionId) === execution) {
              globalMemoryJobs.delete(sessionId);
            }
          });
      },

      deleteMessage(sessionId: string, messageId: string) {
        get().updateConversation(sessionId, (conversation) =>
          conversation.findNode(messageId)?.remove(),
        );
      },

      async retryMessage(sessionId: string, messageId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session || get().currentSession().id !== sessionId) return false;
        const target = Conversation(session).findNode(messageId)?.value;
        if (
          !target ||
          (target.role !== "user" && target.role !== "assistant")
        ) {
          return false;
        }
        await chatOrchestrator.start({
          sessionId,
          content: "",
          isMcpResponse: target.isMcpResponse,
          retry: { sourceNodeId: messageId },
        });
        return true;
      },

      setNextOutlineDelta(sessionId: string, delta?: -1 | 1) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const cursor = session.messages.find(
          (item) => item.id === session.activeCursorId,
        );
        if (!cursor || (delta === -1 && cursor.outlineLevel <= 1)) return;
        get().updateSessionMetadata(sessionId, (draft) => {
          draft.pendingOutlineDelta =
            draft.pendingOutlineDelta === delta ? undefined : delta;
        });
      },

      continueFromNode(sessionId: string, nodeId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const activeIds = new Set(
          Conversation(session)
            .projectActive()
            .map((node) => node.id),
        );
        if (!activeIds.has(nodeId)) return;
        get().updateConversation(sessionId, (conversation) =>
          conversation.moveCursor(nodeId),
        );
      },

      selectConversationBranch(
        sessionId: string,
        parentId: string,
        branchRootId?: string,
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateConversation(sessionId, (conversation) =>
          conversation.node(parentId).selectBranch(branchRootId),
        );
      },

      startConversationBranch(sessionId: string, parentId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const activeIds = new Set(
          Conversation(session)
            .projectActive()
            .map((node) => node.id),
        );
        if (!activeIds.has(parentId)) return;
        get().updateConversation(
          sessionId,
          (conversation) => conversation.moveCursor(parentId),
          { pendingOutlineDelta: 1 },
        );
      },

      insertMessageBetween(
        sessionId: string,
        message: ConversationNode,
        previousId?: string,
        nextId?: string,
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateConversation(sessionId, (conversation) =>
          conversation.insertProjected(message, previousId, nextId),
        );
      },

      swapMessages(sessionId: string, firstId: string, secondId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateConversation(sessionId, (conversation) =>
          conversation.swap(firstId, secondId),
        );
      },

      updateMessageContent(
        sessionId: string,
        messageId: string,
        content: ChatMessage["content"],
      ) {
        get().updateConversation(sessionId, (conversation) =>
          conversation.updateNodeData(messageId, (message) => {
            message.content = content;
          }),
        );
      },

      updateStat(message: ChatMessage, sessionId: string) {
        get().updateSessionMetadata(sessionId, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },

      updateConversation(
        sessionId: string,
        updater: (conversation: ConversationApi) => ConversationApi | undefined,
        sessionPatch: ConversationSessionPatch = {},
      ) {
        updateSession(sessionId, (current) => {
          const conversation = Conversation(current);
          const next = updater(conversation);

          if (!next || next === conversation) return;

          return {
            ...current,
            ...sessionPatch,
            ...next.state,
          };
        });
      },

      updateSessionMetadata(
        sessionId: string,
        updater: (metadata: ChatSessionMetadata) => void | false,
      ) {
        updateSession(sessionId, (current) => {
          const metadata: ChatSessionMetadata = {
            topic: current.topic,
            pendingOutlineDelta: current.pendingOutlineDelta,
            pinnedInputs: deepClone(current.pinnedInputs),
            globalMemory: { ...current.globalMemory },
            stat: { ...current.stat },
            lastUpdate: current.lastUpdate,
            mask: deepClone(current.mask),
          };

          if (updater(metadata) === false) return;

          return {
            ...current,
            ...metadata,
          };
        });
      },

      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },
      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },

      /** check if the message contains MCP JSON and execute the MCP action */
      async checkMcpJson(message: ChatMessage, sessionId?: string) {
        const mcpEnabled = await isMcpEnabled();
        if (!mcpEnabled) return;
        const content = getMessageTextContent(message);
        if (isMcpJson(content)) {
          try {
            const mcpRequest = extractMcpJson(content);
            if (mcpRequest) {
              console.debug("[MCP Request]", mcpRequest);

              executeMcpAction(mcpRequest.clientId, mcpRequest.mcp)
                .then((result) => {
                  console.log("[MCP Response]", result);
                  const mcpResponse =
                    typeof result === "object"
                      ? JSON.stringify(result)
                      : String(result);
                  return chatOrchestrator.start({
                    sessionId: sessionId ?? get().currentSession().id,
                    content: `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    attachImages: [],
                    isMcpResponse: true,
                  });
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },
    };

    summaryMaintenance = createSummaryMaintenance({
      getSession(sessionId) {
        return get().sessions.find((session) => session.id === sessionId);
      },
      updateConversation(sessionId, updater) {
        get().updateConversation(sessionId, updater);
      },
      getClientApi,
      resolveDefaultModel: getSummarizeModel,
      summaryPrompt: Locale.Store.Prompt.Summarize,
    });

    chatOrchestrator = createChatOrchestrator({
      getSession(sessionId) {
        return get().sessions.find((session) => session.id === sessionId);
      },
      updateConversation(sessionId, updater, sessionPatch) {
        get().updateConversation(sessionId, updater, sessionPatch);
      },
      getClientApi,
      completionEffects: {
        dispatch(event) {
          const session = get().sessions.find(
            (item) => item.id === event.sessionId,
          );
          const message = session?.messages.find(
            (item) => item.id === event.assistantNodeId,
          );
          if (!session || !message) return;

          get().updateSessionMetadata(session.id, (draft) => {
            draft.lastUpdate = Date.now();
          });
          get().updateStat(message, session.id);
          get().checkMcpJson(message, session.id);
          get().generateSessionTitle(session);
          if (session.mask.modelConfig.enableConversationSummaries) {
            void get()
              .generateNodeSummary(session.id, message.id)
              .catch((error) => console.error("[Node Summary]", error));
          }
          if (session.globalMemory.enabled) {
            void get().updateGlobalMemory(session.id);
          }
        },
      },
    });

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 4,

    merge(persistedState, currentState) {
      const restoredState = persistedState as
        Partial<typeof DEFAULT_CHAT_STATE> | undefined;
      const sessions = restoredState?.sessions ?? currentState.sessions;
      const stopTiming = Date.now() - REQUEST_TIMEOUT_MS;

      sessions.forEach((session) => {
        session.messages.forEach((message) => {
          const wasStreaming = message.streaming === true;
          if (wasStreaming) message.streaming = false;

          const isStale = new Date(message.date).getTime() < stopTiming;
          if (
            message.content.length === 0 &&
            !message.reasoning &&
            (wasStreaming || message.isError || isStale)
          ) {
            message.streaming = false;
            message.isError = true;
            message.content = prettyObject({
              error: true,
              message: "empty response",
            });
          }
        });
      });

      return {
        ...currentState,
        ...restoredState,
        sessions,
      };
    },

    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          const legacyModelConfig = newSession.mask.modelConfig as any;
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          legacyModelConfig.sendMemory = true;
          legacyModelConfig.historyMessageCount = 4;
          legacyModelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((session) => {
          session.id = nanoid();
          session.messages.forEach((message) => (message.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((session) => {
          if (
            // Exclude those already set by user
            !session.mask.modelConfig.hasOwnProperty(
              "enableInjectSystemPrompts",
            )
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default.
            const config = useAppConfig.getState();
            session.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((session) => {
          session.mask.modelConfig.compressModel = "";
          session.mask.modelConfig.compressProviderName = "";
        });
      }

      if (version < 4) {
        newState.sessions.forEach((session: any) => {
          migrateSessionToConversation(session);
        });
      }

      return newState as any;
    },
  },
);
