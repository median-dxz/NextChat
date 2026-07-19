import {
  getMessageTextContent,
  isDalle3,
  safeLocalStorage,
  trimTopic,
} from "../utils";

import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type { ClientApi } from "../client/api";
import { getClientApi } from "../client/api";
import { showToast } from "../components/ui-lib";
import {
  GEMINI_SUMMARIZE_MODEL,
  DEEPSEEK_SUMMARIZE_MODEL,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
} from "../constant";
import Locale from "../locales";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import {
  Conversation,
  createMessage,
  type ChatMessage,
  type ConversationNode,
  type NodeSummaryKind,
} from "../utils/conversation";
import { ModelConfig, useAppConfig } from "./config";
import { useAccessStore } from "./access";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createEmptyMask, Mask } from "./mask";
import { executeMcpAction, isMcpEnabled } from "@/app/mcp/actions";
import { extractMcpJson, isMcpJson } from "../mcp/utils";
import type {
  ConversationGraphState,
  GlobalMemory,
} from "../utils/conversation";
import {
  createChatOrchestrator,
  type ChatOrchestrator,
} from "./chat-orchestrator";
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

function requestOneShot(
  api: ClientApi,
  messages: ChatMessage[],
  modelConfig: ModelConfig,
  model: string,
  providerName: string,
) {
  return new Promise<string>((resolve, reject) => {
    const { max_tokens, ...config } = modelConfig;
    api.llm.chat({
      messages,
      config: { ...config, stream: false, model, providerName },
      onReasoningUpdate() {},
      onFinish(message, response) {
        if (response?.status === 200 && message.trim()) resolve(message.trim());
        else {
          reject(
            new Error(
              `Global memory request failed (${providerName}/${model}, status ${response?.status ?? "unknown"})`,
            ),
          );
        }
      },
      onError: reject,
    });
  });
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

export function getSessionActiveMessages(session: ChatSession) {
  return Conversation(session).projectActive();
}

export function getSessionMessagesToCursor(session: ChatSession) {
  return Conversation(session).projectToCursor();
}

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
  const pinnedInputs = Array.isArray(session.pinnedInputs)
    ? session.pinnedInputs
    : [];
  const nodes = migrateMessagesToConversationNodes([
    ...presetNodes,
    ...oldMessages,
  ]);
  session.messages = nodes;
  session.rootNodeId = nodes[0]?.id;
  session.activeCursorId = nodes.at(-1)?.id;
  session.pinnedInputs = [
    ...pinnedInputs,
    ...maskContext.filter((message: ChatMessage) => message.role === "system"),
  ].map((message) => ({ ...message, outlineLevel: 0 }));
  const oldMemory = String(session.memoryPrompt ?? "").trim();
  session.globalMemory = oldMemory
    ? {
        ...Conversation.createMemory(),
        enabled: true,
        content: oldMemory,
      }
    : (session.globalMemory ?? Conversation.createMemory());
  session.mask.context = [];
  session.mask.modelConfig.contextWindowTokens ??= 32_000;
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
  delete session.memoryPrompt;
  delete session.lastSummarizeIndex;
  delete session.clearContextIndex;
  delete session.pendingOutlineDelta;

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

    const methods = {
      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 克隆消息图并重建节点 ID
        const { graph } = Conversation(currentSession).clone(nanoid);
        newSession.messages = graph.messages;
        newSession.rootNodeId = graph.rootNodeId;
        newSession.activeCursorId = graph.activeCursorId;
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

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.rootNodeId = undefined;
          session.activeCursorId = undefined;
          session.pendingOutlineDelta = undefined;
          session.globalMemory = Conversation.createMemory();
        });
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
        const titleApi: ClientApi = getClientApi(
          titleProviderName as ServiceProvider,
        );

        // remove error messages if any
        const messages = getSessionMessagesToCursor(session);

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
          titleApi.llm.chat({
            messages: topicMessages,
            config: {
              model: titleModel,
              stream: false,
              providerName: titleProviderName,
            },
            // Reasoning is intentionally not persisted as a title.
            onReasoningUpdate() {},
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                get().updateTargetSession(
                  session,
                  (session) =>
                    (session.topic =
                      message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
                );
              }
            },
          });
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
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const summary = Conversation(draft).summaries.findNode(nodeId);
          if (!summary) return;
          draft.messages = summary.remove(kind).messages;
        });
      },

      editGlobalMemory(
        sessionId: string,
        update: Partial<Pick<GlobalMemory, "enabled" | "prompt" | "content">>,
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
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
            const content = await requestOneShot(
              getClientApi(providerName as ServiceProvider),
              messages,
              modelConfig,
              model,
              providerName,
            );
            const current = get().sessions.find(
              (item) => item.id === sessionId,
            );
            if (!current || current.globalMemory.revision !== revision) return;
            get().updateTargetSession(current, (draft) => {
              if (draft.globalMemory.revision !== revision) return;
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
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const node = Conversation(draft).findNode(messageId);
          if (!node) return;
          const graph = node.remove();
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
          draft.activeCursorId = graph.activeCursorId;
        });
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
        get().updateTargetSession(session, (draft) => {
          draft.pendingOutlineDelta =
            draft.pendingOutlineDelta === delta ? undefined : delta;
        });
      },

      continueFromNode(sessionId: string, nodeId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const activeIds = new Set(
          getSessionActiveMessages(session).map((node) => node.id),
        );
        if (!activeIds.has(nodeId)) return;
        get().updateTargetSession(session, (draft) => {
          draft.activeCursorId = nodeId;
        });
      },

      selectConversationBranch(
        sessionId: string,
        parentId: string,
        branchRootId?: string,
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const graph = Conversation(draft)
            .node(parentId)
            .selectBranch(branchRootId);
          draft.messages = graph.messages;
          draft.activeCursorId = graph.activeCursorId;
        });
      },

      startConversationBranch(sessionId: string, parentId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        const activeIds = new Set(
          getSessionActiveMessages(session).map((node) => node.id),
        );
        if (!activeIds.has(parentId)) return;
        get().updateTargetSession(session, (draft) => {
          draft.activeCursorId = parentId;
          draft.pendingOutlineDelta = 1;
        });
      },

      insertMessageBetween(
        sessionId: string,
        message: ConversationNode,
        previousId?: string,
        nextId?: string,
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const graph = Conversation(draft).insertProjected(
            message,
            previousId,
            nextId,
          );
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
          draft.activeCursorId = graph.activeCursorId;
        });
      },

      swapMessages(sessionId: string, firstId: string, secondId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const graph = Conversation(draft).swap(firstId, secondId);
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
        });
      },

      updateMessageContent(
        sessionId: string,
        messageId: string,
        content: ChatMessage["content"],
      ) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const message = draft.messages.find((item) => item.id === messageId);
          if (!message) return;
          message.content = content;
          if (message.role === "assistant") message.reasoning = undefined;
        });
      },

      updateStat(message: ChatMessage, session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },
      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
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
      updateSession(sessionId, updater) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (session) get().updateTargetSession(session, updater);
      },
      getClientApi,
      resolveDefaultModel: getSummarizeModel,
      summaryPrompt: Locale.Store.Prompt.Summarize,
    });

    chatOrchestrator = createChatOrchestrator({
      getSession(sessionId) {
        return get().sessions.find((session) => session.id === sessionId);
      },
      updateSession(sessionId, updater) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (session) get().updateTargetSession(session, updater);
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

          get().updateTargetSession(session, (draft) => {
            draft.messages = draft.messages.concat();
            draft.lastUpdate = Date.now();
          });
          get().updateStat(message, session);
          get().checkMcpJson(message, session.id);
          get().generateSessionTitle(session);
          if (session.mask.modelConfig.sendMemory) {
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
    version: 4.3,
    merge(persistedState, currentState) {
      const restoredState = persistedState as
        Partial<typeof DEFAULT_CHAT_STATE> | undefined;
      const sessions = restoredState?.sessions ?? currentState.sessions;

      sessions.forEach((session) => {
        session.pinnedInputs ??= [];
        session.pinnedInputs = session.pinnedInputs.map((message) => ({
          ...message,
          outlineLevel: 0,
        }));
        session.globalMemory ??= Conversation.createMemory();
        session.mask.modelConfig.memoryModel ??= "";
        session.mask.modelConfig.memoryProviderName ??= "";
        if (session.messages.length > 0) {
          session.rootNodeId ??= session.messages[0]?.id;
        }
        session.messages.forEach((message) => {
          if (message.streaming === true) {
            message.streaming = false;
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
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.recentRawNodeCount = 4;
          newSession.mask.modelConfig.segmentTargetSourceTokens = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressProviderName =
            config.modelConfig.compressProviderName;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressProviderName = "";
        });
      }

      if (version < 4.3) {
        newState.sessions.forEach((session: any) => {
          migrateSessionToConversation(session);
        });
      }

      return newState as any;
    },
  },
);
