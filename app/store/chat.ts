import {
  getMessageTextContent,
  isDalle3,
  safeLocalStorage,
  trimTopic,
} from "../utils";

import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type {
  ClientApi,
  MultimodalContent,
  RequestMessage,
} from "../client/api";
import { getClientApi } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { showToast } from "../components/ui-lib";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  GEMINI_SUMMARIZE_MODEL,
  DEEPSEEK_SUMMARIZE_MODEL,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
} from "../constant";
import Locale, { getLang } from "../locales";
import { prettyObject } from "../utils/format";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import {
  ConversationSummary,
  createContextProjection,
  createSummarySourceDigest,
  estimateRequestMessageTokens,
  getEffectiveMaxOutputTokens,
  getContextInputBudget,
  planSummaryMaintenance,
} from "../utils/context-compression";
import {
  materializeNodeSummaries,
  planNodeConversationContext,
  planNodeSummarySource,
} from "../utils/node-summary";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { useAccessStore } from "./access";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createEmptyMask, Mask } from "./mask";
import { executeMcpAction, getAllTools, isMcpEnabled } from "@/app/mcp/actions";
import { extractMcpJson, isMcpJson } from "../mcp/utils";
import {
  ConversationNode,
  ConversationGraphState,
  GlobalMemory,
  createConversationGraphIndex,
  createEmptyGlobalMemory,
  deleteConversationNode,
  insertConversationNode,
  insertProjectedConversationNode,
  projectActiveConversation,
  projectConversationToCursor,
  remapConversationNodes,
  setActiveConversationBranch,
  swapConversationNodes,
  toLevelOneConversationNodes,
  validateConversationGraph,
} from "../utils/conversation-graph";

const localStorage = safeLocalStorage();
const summaryJobs = new Map<string, Promise<void>>();
const nodeSummaryJobs = new Map<string, Promise<void>>();
const globalMemoryJobs = new Map<string, Promise<void>>();

function requestSummary(
  api: ClientApi,
  messages: ChatMessage[],
  modelConfig: ModelConfig,
  model: string,
  providerName: string,
) {
  return new Promise<string>((resolve, reject) => {
    const { max_tokens, ...config } = modelConfig;
    api.llm.chat({
      messages: messages.concat(
        createMessage({
          role: "system",
          content: Locale.Store.Prompt.Summarize,
          date: "",
        }),
      ),
      config: { ...config, stream: false, model, providerName },
      // Reasoning is intentionally ignored; only the final answer is stored.
      onReasoningUpdate() {},
      onFinish(message, response) {
        if (response?.status === 200 && message.trim()) resolve(message.trim());
        else {
          reject(
            new Error(
              `Summary request failed (${providerName}/${model}, status ${response?.status ?? "unknown"})`,
            ),
          );
        }
      },
      onError: reject,
    });
  });
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

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

export type ChatMessage = RequestMessage & {
  date: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
  deletedAt?: number;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export function createConversationNode(
  override: Partial<ConversationNode>,
): ConversationNode {
  return {
    ...createMessage(override),
    outlineLevel: override.outlineLevel ?? 1,
    parentId: override.parentId,
    activeBranchRootId: override.activeBranchRootId,
    hidden: override.hidden,
    nodeSummaries: override.nodeSummaries,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  summaries: ConversationSummary[];
  messages: ConversationNode[];
  rootNodeId?: string;
  activeCursorId?: string;
  pendingOutlineDelta?: -1 | 1;
  pinnedInputs: ChatMessage[];
  globalMemory: GlobalMemory;
  stat: ChatStat;
  lastUpdate: number;
  contextBoundaryAfterMessageId?: string;

  mask: Mask;
}

export function getSessionActiveMessages(session: ChatSession) {
  return projectActiveConversation(session);
}

export function getSessionMessagesToCursor(session: ChatSession) {
  return projectConversationToCursor(session);
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
    summaries: [],
    messages: [],
    pinnedInputs: [],
    globalMemory: createEmptyGlobalMemory(),
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    mask: createEmptyMask(),
  };
}

function materializeMaskContext(session: ChatSession) {
  const context = session.mask.context.slice();
  const pinnedInputs = context.filter((message) => message.role === "system");
  const startingMessages = context.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const nodes = toLevelOneConversationNodes(startingMessages);
  session.pinnedInputs = pinnedInputs.map((message) => ({ ...message }));
  session.messages = nodes;
  session.rootNodeId = nodes[0]?.id;
  session.activeCursorId = nodes.at(-1)?.id;
  session.mask = { ...session.mask, context: [] };
}

function migrateSessionToConversationGraph(session: any) {
  const oldMessages = Array.isArray(session.messages) ? session.messages : [];
  const maskContext = Array.isArray(session.mask?.context)
    ? session.mask.context
    : [];
  const presetNodes = maskContext.filter(
    (message: ChatMessage) =>
      message.role === "user" || message.role === "assistant",
  );
  const nodes = toLevelOneConversationNodes([...presetNodes, ...oldMessages]);
  const oldBoundary = Math.max(0, session.clearContextIndex ?? 0);
  const presetOffset = presetNodes.length;

  session.messages = nodes;
  session.rootNodeId = nodes[0]?.id;
  session.activeCursorId = nodes.at(-1)?.id;
  session.pinnedInputs = [
    ...(Array.isArray(session.pinnedInputs) ? session.pinnedInputs : []),
    ...maskContext.filter((message: ChatMessage) => message.role === "system"),
  ];
  const oldMemory = String(session.memoryPrompt ?? "");
  session.globalMemory = oldMemory.trim()
    ? {
        ...createEmptyGlobalMemory(),
        enabled: true,
        content: oldMemory,
      }
    : (session.globalMemory ?? createEmptyGlobalMemory());
  session.contextBoundaryAfterMessageId ??=
    oldBoundary > 0 ? nodes[presetOffset + oldBoundary - 1]?.id : undefined;
  session.summaries ??= [];
  session.mask.context = [];
  session.mask.modelConfig.contextWindowTokens ??= 32_000;
  session.mask.modelConfig.titleModel ??= "";
  session.mask.modelConfig.titleProviderName ??= "";
  delete session.memoryPrompt;
  delete session.lastSummarizeIndex;
  delete session.clearContextIndex;
  delete session.pendingOutlineDelta;

  validateConversationGraph(session);
}

function getSummarizeModel(
  currentModel: string,
  providerName: string,
): string[] {
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

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
  const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

  var serviceProvider = "OpenAI";
  if (modelInfo) {
    // TODO: auto detect the providerName from the modelConfig.model

    // Directly use the providerName from the modelInfo
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

async function getMcpSystemPrompt(): Promise<string> {
  const tools = await getAllTools();

  let toolsStr = "";

  tools.forEach((i) => {
    // error client has no tools
    if (!i.tools) return;

    toolsStr += MCP_TOOLS_TEMPLATE.replace(
      "{{ clientId }}",
      i.clientId,
    ).replace(
      "{{ tools }}",
      i.tools.tools.map((p: object) => JSON.stringify(p, null, 2)).join("\n"),
    );
  });

  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsStr);
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

    async function generateSummary({
      sessionId,
      sourceEntryIds,
      sourceDigest,
      inputSummaryIds,
      allowRawFallback = false,
    }: {
      sessionId: string;
      sourceEntryIds: string[];
      sourceDigest: string;
      inputSummaryIds: string[];
      allowRawFallback?: boolean;
    }) {
      const session = get().sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const projection = createContextProjection(
        getSessionMessagesToCursor(session),
        session.contextBoundaryAfterMessageId,
      );
      const messagesById = new Map(
        projection.entries.map((message) => [message.id, message]),
      );
      const sourceMessages = sourceEntryIds
        .map((id) => messagesById.get(id))
        .filter((message): message is ConversationNode => Boolean(message));
      if (
        sourceMessages.length !== sourceEntryIds.length ||
        createSummarySourceDigest(sourceMessages) !== sourceDigest
      ) {
        return;
      }

      const inputSummaries = inputSummaryIds
        .map((id) => session.summaries.find((summary) => summary.id === id))
        .filter((summary): summary is ConversationSummary => Boolean(summary));
      const useSummaryInputs =
        inputSummaryIds.length > 0 &&
        inputSummaries.length === inputSummaryIds.length;
      if (
        inputSummaryIds.length > 0 &&
        !useSummaryInputs &&
        !allowRawFallback
      ) {
        return;
      }
      const inputMessages: ChatMessage[] = useSummaryInputs
        ? inputSummaries.map((summary) =>
            createMessage({
              role: "system",
              content: summary.content,
              date: "",
            }),
          )
        : sourceMessages;
      const inputSnapshot = useSummaryInputs
        ? JSON.stringify(
            inputSummaries.map((summary) => [summary.id, summary.content]),
          )
        : sourceDigest;

      const modelConfig = session.mask.modelConfig;
      const [model, providerName] = modelConfig.compressModel
        ? [modelConfig.compressModel, modelConfig.compressProviderName]
        : getSummarizeModel(modelConfig.model, modelConfig.providerName);
      const content = await requestSummary(
        getClientApi(providerName as ServiceProvider),
        inputMessages,
        modelConfig,
        model,
        providerName,
      );

      const current = get().sessions.find((item) => item.id === sessionId);
      if (!current) return;
      const currentProjection = createContextProjection(
        getSessionMessagesToCursor(current),
        current.contextBoundaryAfterMessageId,
      );
      const currentMessagesById = new Map(
        currentProjection.entries.map((message) => [message.id, message]),
      );
      const currentSourceMessages = sourceEntryIds
        .map((id) => currentMessagesById.get(id))
        .filter((message): message is ConversationNode => Boolean(message));
      if (
        currentSourceMessages.length !== sourceEntryIds.length ||
        createSummarySourceDigest(currentSourceMessages) !== sourceDigest
      ) {
        return;
      }
      if (useSummaryInputs) {
        const currentInputSnapshot = JSON.stringify(
          inputSummaryIds.map((id) => {
            const summary = current.summaries.find((item) => item.id === id);
            return summary ? [summary.id, summary.content] : undefined;
          }),
        );
        if (currentInputSnapshot !== inputSnapshot) return;
      }

      return {
        session: current,
        content,
        inputSummaryIds: useSummaryInputs ? inputSummaryIds : [],
      };
    }

    const methods = {
      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 深拷贝消息
        const { nodes, ids: messageIds } = remapConversationNodes(
          currentSession.messages,
          nanoid,
        );
        newSession.messages = nodes;
        newSession.rootNodeId = currentSession.rootNodeId
          ? messageIds.get(currentSession.rootNodeId)
          : undefined;
        newSession.activeCursorId = currentSession.activeCursorId
          ? messageIds.get(currentSession.activeCursorId)
          : undefined;
        newSession.pinnedInputs = currentSession.pinnedInputs.map(
          (message) => ({
            ...message,
            id: nanoid(),
          }),
        );
        newSession.globalMemory = { ...currentSession.globalMemory };
        // Summaries are derived from message IDs, so the fork rebuilds them.
        newSession.summaries = [];
        newSession.contextBoundaryAfterMessageId =
          currentSession.contextBoundaryAfterMessageId
            ? messageIds.get(currentSession.contextBoundaryAfterMessageId)
            : undefined;
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

      onNewMessage(message: ChatMessage, targetSession: ChatSession) {
        get().updateTargetSession(targetSession, (session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = Date.now();
        });

        get().updateStat(message, targetSession);

        get().checkMcpJson(message);

        get().generateSessionTitle(targetSession);
        if (targetSession.mask.modelConfig.sendMemory) {
          void get().generateNodeSummary(targetSession.id, message.id);
        }
        if (targetSession.globalMemory.enabled) {
          void get().updateGlobalMemory(targetSession.id);
        }
      },

      async onUserInput(
        content: string,
        attachImages?: string[],
        isMcpResponse?: boolean,
        retry?: {
          source: ConversationNode;
          reuseUser: boolean;
          insertBeforeId?: string;
        },
      ) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;

        // MCP Response no need to fill template
        let mContent: string | MultimodalContent[] = retry
          ? retry.source.content
          : isMcpResponse
            ? content
            : fillTemplateWith(content, modelConfig);

        if (
          !retry &&
          !isMcpResponse &&
          attachImages &&
          attachImages.length > 0
        ) {
          mContent = [
            ...(content ? [{ type: "text" as const, text: content }] : []),
            ...attachImages.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ];
        }

        let userMessage: ConversationNode = retry?.reuseUser
          ? { ...retry.source }
          : createConversationNode({
              role: "user",
              content: mContent,
              isMcpResponse: retry?.source.isMcpResponse ?? isMcpResponse,
            });

        const botMessage: ConversationNode = createConversationNode({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });
        let reasoningStartedAt: number | undefined;
        const finishReasoningTiming = () => {
          if (
            reasoningStartedAt !== undefined &&
            botMessage.reasoningDurationMs === undefined
          ) {
            botMessage.reasoningDurationMs = Math.max(
              0,
              Date.now() - reasoningStartedAt,
            );
          }
        };

        // get recent messages
        const recentMessages = await get().getMessagesWithMemory(
          retry?.reuseUser ? undefined : userMessage,
        );
        const sendMessages = retry?.reuseUser
          ? recentMessages
          : recentMessages.concat(userMessage);
        const effectiveMaxOutputTokens = getEffectiveMaxOutputTokens(
          modelConfig.contextWindowTokens,
          modelConfig.max_tokens,
          sendMessages.reduce(
            (sum, message) => sum + estimateRequestMessageTokens(message),
            0,
          ),
        );
        const messageIndex = session.messages.length + 1;

        // save user's and bot's message
        get().updateTargetSession(session, (session) => {
          const savedUserMessage: ConversationNode = retry?.reuseUser
            ? userMessage
            : { ...userMessage, content: mContent };
          let graph = retry?.reuseUser
            ? session
            : retry?.insertBeforeId
              ? insertProjectedConversationNode(
                  session,
                  savedUserMessage,
                  undefined,
                  retry.insertBeforeId,
                )
              : insertConversationNode(
                  session,
                  savedUserMessage,
                  session.pendingOutlineDelta ?? 0,
                );
          graph = insertConversationNode(
            graph,
            botMessage,
            0,
            savedUserMessage.id,
          );
          const insertedUser = graph.messages.find(
            (message) => message.id === savedUserMessage.id,
          )!;
          const insertedBot = graph.messages.find(
            (message) => message.id === botMessage.id,
          )!;
          Object.assign(userMessage, {
            parentId: insertedUser.parentId,
            outlineLevel: insertedUser.outlineLevel,
          });
          Object.assign(botMessage, {
            parentId: insertedBot.parentId,
            outlineLevel: insertedBot.outlineLevel,
          });
          session.messages = graph.messages;
          session.rootNodeId = graph.rootNodeId;
          session.activeCursorId = graph.activeCursorId;
          session.pendingOutlineDelta = undefined;
        });

        const syncMessage = (message: ConversationNode) => {
          get().updateTargetSession(session, (current) => {
            const target = current.messages.find(
              (item) => item.id === message.id,
            );
            if (target) Object.assign(target, message);
          });
        };

        const api: ClientApi = getClientApi(modelConfig.providerName);
        // make request
        api.llm.chat({
          messages: sendMessages,
          config: {
            ...modelConfig,
            max_tokens: effectiveMaxOutputTokens,
            stream: true,
          },
          onUpdate(message) {
            botMessage.streaming = true;
            if (message) {
              finishReasoningTiming();
              botMessage.content = message;
            }
            syncMessage(botMessage);
          },
          onReasoningUpdate(reasoning) {
            botMessage.streaming = true;
            reasoningStartedAt ??= Date.now();
            botMessage.reasoning = reasoning;
            syncMessage(botMessage);
          },
          async onFinish(message) {
            botMessage.streaming = false;
            finishReasoningTiming();
            if (message || botMessage.reasoning) {
              botMessage.content = message;
              botMessage.date = new Date().toLocaleString();
              syncMessage(botMessage);
              get().onNewMessage(botMessage, session);
            } else {
              syncMessage(botMessage);
            }
            ChatControllerPool.remove(session.id, botMessage.id);
          },
          onBeforeTool(tool: ChatMessageTool) {
            (botMessage.tools = botMessage?.tools || []).push(tool);
            syncMessage(botMessage);
          },
          onAfterTool(tool: ChatMessageTool) {
            botMessage?.tools?.forEach((t, i, tools) => {
              if (tool.id == t.id) {
                tools[i] = { ...tool };
              }
            });
            syncMessage(botMessage);
          },
          onError(error) {
            const isAborted = error.message?.includes?.("aborted");
            botMessage.content +=
              "\n\n" +
              prettyObject({
                error: true,
                message: error.message,
              });
            botMessage.streaming = false;
            finishReasoningTiming();
            userMessage.isError = !isAborted;
            botMessage.isError = !isAborted;
            syncMessage(userMessage);
            syncMessage(botMessage);
            ChatControllerPool.remove(
              session.id,
              botMessage.id ?? messageIndex,
            );

            console.error("[Chat] failed ", error);
          },
          onController(controller) {
            // collect controller for stop/retry
            ChatControllerPool.addController(
              session.id,
              botMessage.id ?? messageIndex,
              controller,
            );
          },
        });
      },

      async getMessagesWithMemory(currentInput?: RequestMessage) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const contextPrompts = session.pinnedInputs.slice();

        // system prompts, to get close to OpenAI Web ChatGPT
        const shouldInjectSystemPrompts =
          modelConfig.enableInjectSystemPrompts &&
          (session.mask.modelConfig.model.startsWith("gpt-") ||
            session.mask.modelConfig.model.startsWith("chatgpt-"));

        const mcpEnabled = await isMcpEnabled();
        const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";

        var systemPrompts: ChatMessage[] = [];

        if (shouldInjectSystemPrompts) {
          systemPrompts = [
            createMessage({
              role: "system",
              content:
                fillTemplateWith("", {
                  ...modelConfig,
                  template: DEFAULT_SYSTEM_TEMPLATE,
                }) + mcpSystemPrompt,
            }),
          ];
        } else if (mcpEnabled) {
          systemPrompts = [
            createMessage({
              role: "system",
              content: mcpSystemPrompt,
            }),
          ];
        }

        if (shouldInjectSystemPrompts || mcpEnabled) {
          console.log(
            "[Global System Prompt] ",
            systemPrompts.at(0)?.content ?? "empty",
          );
        }
        const globalMemoryPrompts =
          session.globalMemory.enabled && session.globalMemory.content.trim()
            ? [
                createMessage({
                  role: "system",
                  content: session.globalMemory.content,
                  date: "",
                }),
              ]
            : [];
        const fixedMessages = [
          ...systemPrompts,
          ...globalMemoryPrompts,
          ...contextPrompts,
        ];
        const createPlan = () => {
          const current = get().sessions.find((item) => item.id === session.id);
          if (!current) throw new Error("Chat session no longer exists");
          const projection = createContextProjection(
            getSessionMessagesToCursor(current),
            current.contextBoundaryAfterMessageId,
          );
          const summaries = modelConfig.sendMemory
            ? [
                ...current.summaries,
                ...materializeNodeSummaries(projection.entries),
              ]
            : [];
          return {
            current,
            summaries,
            plan: planNodeConversationContext({
              projection,
              summaries,
              historyMessageCount: modelConfig.historyMessageCount,
              contextWindowTokens: modelConfig.contextWindowTokens,
              maxOutputTokens: modelConfig.max_tokens,
              fixedTokenCount: fixedMessages.reduce(
                (sum, message) => sum + estimateRequestMessageTokens(message),
                0,
              ),
              currentInputTokenCount: currentInput
                ? estimateRequestMessageTokens(currentInput)
                : 0,
            }),
          };
        };

        const planned = createPlan();
        if (planned.plan.overflow) {
          throw new Error(
            "System prompts and current input exceed the context window",
          );
        }
        const selectedSummaries = planned.plan.selectedSummaryIds
          .map((id) => planned.summaries.find((item) => item.id === id))
          .filter((item): item is ConversationSummary => Boolean(item))
          .map((item) =>
            createMessage({
              role: "system",
              content: Locale.Store.Prompt.History(item.content),
              date: "",
            }),
          );
        const selectedMessages = planned.plan.selectedMessageIds
          .map((id) => planned.current.messages.find((item) => item.id === id))
          .filter((item): item is ConversationNode => Boolean(item))
          .map((item) => (item.hidden ? { ...item, content: "" } : item));

        return [
          ...systemPrompts,
          ...globalMemoryPrompts,
          ...selectedSummaries,
          ...contextPrompts,
          ...selectedMessages,
        ];
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
          session.summaries = [];
          session.rootNodeId = undefined;
          session.activeCursorId = undefined;
          session.pendingOutlineDelta = undefined;
          session.globalMemory = createEmptyGlobalMemory();
          session.contextBoundaryAfterMessageId = undefined;
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
            messages.length - modelConfig.historyMessageCount,
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

      async maintainSummaries(sessionId: string, force = false): Promise<void> {
        const pending = summaryJobs.get(sessionId);
        if (pending) {
          return force
            ? pending
            : pending.catch((error) => console.error("[Summarize]", error));
        }

        const runMaintenance = async () => {
          const session = get().sessions.find((item) => item.id === sessionId);
          if (!session || !session.mask.modelConfig.sendMemory) return;
          const modelConfig = session.mask.modelConfig;
          const projection = createContextProjection(
            getSessionMessagesToCursor(session),
            session.contextBoundaryAfterMessageId,
          );
          const plan = planSummaryMaintenance({
            projection,
            summaries: session.summaries,
            historyMessageCount: modelConfig.historyMessageCount,
            inputBudget: getContextInputBudget(
              modelConfig.contextWindowTokens,
              modelConfig.max_tokens,
            ),
            compressionThreshold: modelConfig.compressMessageLengthThreshold,
            force,
          });
          if (!plan) return;
          const generated = await generateSummary({ sessionId, ...plan });
          if (!generated) return;
          get().updateTargetSession(generated.session, (draft) => {
            draft.summaries.push({
              id: nanoid(),
              kind: plan.kind,
              content: generated.content,
              sourceEntryIds: plan.sourceEntryIds,
              sourceDigest: plan.sourceDigest,
              inputSummaryIds: generated.inputSummaryIds,
            });
          });
        };
        const execution = runMaintenance().finally(() =>
          summaryJobs.delete(sessionId),
        );
        summaryJobs.set(sessionId, execution);
        return force
          ? execution
          : execution.catch((error) => console.error("[Summarize]", error));
      },

      async generateNodeSummary(
        sessionId: string,
        nodeId: string,
        force = false,
      ): Promise<void> {
        const jobKey = `${sessionId}:${nodeId}`;
        const pending = nodeSummaryJobs.get(jobKey);
        if (pending) return force ? pending : undefined;

        const run = async () => {
          const session = get().sessions.find((item) => item.id === sessionId);
          const node = session?.messages.find((item) => item.id === nodeId);
          if (!session || !node || node.role !== "assistant") return;
          if (!force && node.summaryAttemptedAt) return;

          const modelConfig = session.mask.modelConfig;
          const projection = projectConversationToCursor({
            ...session,
            activeCursorId: node.id,
          });
          const plan = planNodeSummarySource(
            projection,
            node.id,
            getContextInputBudget(
              modelConfig.contextWindowTokens,
              modelConfig.max_tokens,
            ),
            modelConfig.compressMessageLengthThreshold,
          );
          if (!plan) return;

          const attemptedAt = Date.now();
          get().updateTargetSession(session, (draft) => {
            const target = draft.messages.find((item) => item.id === node.id);
            if (target) target.summaryAttemptedAt = attemptedAt;
          });
          if (!force && node.nodeSummaries?.[plan.kind]) return;

          const [model, providerName] = modelConfig.compressModel
            ? [modelConfig.compressModel, modelConfig.compressProviderName]
            : getSummarizeModel(modelConfig.model, modelConfig.providerName);
          const content = await requestSummary(
            getClientApi(providerName as ServiceProvider),
            plan.inputNodes.map((input) =>
              input.hidden ? { ...input, content: "" } : input,
            ),
            modelConfig,
            model,
            providerName,
          );

          const current = get().sessions.find((item) => item.id === sessionId);
          if (!current) return;
          get().updateTargetSession(current, (draft) => {
            const target = draft.messages.find((item) => item.id === node.id);
            if (!target || target.role !== "assistant") return;
            if (!force && target.nodeSummaries?.[plan.kind]) return;
            const previous = target.nodeSummaries?.[plan.kind];
            const now = Date.now();
            target.nodeSummaries ??= {};
            target.nodeSummaries[plan.kind] = {
              content,
              sourceNodeIds: plan.sourceNodeIds,
              tokenCount: estimateTokenLength(content),
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
          });
        };
        const execution = run().finally(() => nodeSummaryJobs.delete(jobKey));
        nodeSummaryJobs.set(jobKey, execution);
        return force
          ? execution
          : execution.catch((error) => console.error("[Node Summary]", error));
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

      async updateGlobalMemory(sessionId: string, prompt?: string) {
        const previous = globalMemoryJobs.get(sessionId) ?? Promise.resolve();
        const execution = previous
          .catch(() => undefined)
          .then(async () => {
            const session = get().sessions.find(
              (item) => item.id === sessionId,
            );
            if (!session || !session.globalMemory.enabled) return;
            const memoryPrompt = (prompt ?? session.globalMemory.prompt).trim();
            if (!memoryPrompt) return;

            const projection = projectConversationToCursor(session);
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
            const [model, providerName] = modelConfig.compressModel
              ? [modelConfig.compressModel, modelConfig.compressProviderName]
              : getSummarizeModel(modelConfig.model, modelConfig.providerName);
            const messages: ChatMessage[] = [
              createMessage({
                role: "system",
                content: memoryPrompt,
                date: "",
              }),
              createMessage({
                role: "system",
                content: session.globalMemory.content,
                date: "",
              }),
              user.hidden ? { ...user, content: "" } : user,
              assistant.hidden ? { ...assistant, content: "" } : assistant,
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

      async recompressSummary(sessionId: string, summaryId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        const summary = session?.summaries.find(
          (item) => item.id === summaryId,
        );
        if (!session || !summary) return;
        const generated = await generateSummary({
          sessionId,
          sourceEntryIds: summary.sourceEntryIds,
          sourceDigest: summary.sourceDigest,
          inputSummaryIds: summary.inputSummaryIds,
          allowRawFallback: true,
        });
        if (!generated) return;
        get().updateTargetSession(generated.session, (draft) => {
          const previousIndex = draft.summaries.findIndex(
            (item) => item.id === summaryId,
          );
          if (previousIndex < 0) return;
          const previous = draft.summaries[previousIndex];
          draft.summaries[previousIndex] = {
            ...previous,
            id: nanoid(),
            content: generated.content,
            inputSummaryIds: generated.inputSummaryIds,
          };
        });
      },

      deleteSummary(sessionId: string, summaryId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          draft.summaries = draft.summaries.filter(
            (summary) => summary.id !== summaryId,
          );
        });
      },

      deleteMessage(sessionId: string, messageId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const graph = deleteConversationNode(draft, messageId);
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
          draft.activeCursorId = graph.activeCursorId;
          if (
            draft.contextBoundaryAfterMessageId &&
            !graph.messages.some(
              (message) => message.id === draft.contextBoundaryAfterMessageId,
            )
          ) {
            draft.contextBoundaryAfterMessageId = undefined;
          }
        });
      },

      async retryMessage(sessionId: string, messageId: string) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session || get().currentSession().id !== sessionId) return false;
        const index = createConversationGraphIndex(session.messages);
        const target = index.nodesById.get(messageId);
        if (
          !target ||
          (target.role !== "user" && target.role !== "assistant")
        ) {
          return false;
        }

        let source: ConversationNode;
        let reuseUser = false;
        let insertBeforeId: string | undefined;
        const removedIds = new Set<string>([target.id]);
        let graph: ConversationGraphState = session;

        if (target.role === "assistant") {
          const user = target.parentId
            ? index.nodesById.get(target.parentId)
            : undefined;
          if (!user || user.role !== "user") {
            throw new Error("An assistant retry requires its direct user node");
          }
          source = { ...user };
          reuseUser = true;
          graph = deleteConversationNode(graph, target.id);
          graph = { ...graph, activeCursorId: user.id };
          validateConversationGraph(graph);
        } else {
          source = { ...target };
          const response = index.sameLevelChildByParentId.get(target.id);
          graph = deleteConversationNode(graph, target.id);
          if (response?.role === "assistant") {
            removedIds.add(response.id);
            graph = deleteConversationNode(graph, response.id);
          }
          graph = { ...graph, activeCursorId: target.parentId };
          validateConversationGraph(graph);
          if (!target.parentId) insertBeforeId = graph.rootNodeId;
        }

        get().updateTargetSession(session, (draft) => {
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
          draft.activeCursorId = graph.activeCursorId;
          draft.pendingOutlineDelta = undefined;
          if (
            draft.contextBoundaryAfterMessageId &&
            removedIds.has(draft.contextBoundaryAfterMessageId)
          ) {
            draft.contextBoundaryAfterMessageId = undefined;
          }
        });

        await get().onUserInput("", undefined, source.isMcpResponse, {
          source,
          reuseUser,
          insertBeforeId,
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
          const graph = setActiveConversationBranch(
            draft,
            parentId,
            branchRootId,
          );
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
          const graph = insertProjectedConversationNode(
            draft,
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
          const graph = swapConversationNodes(draft, firstId, secondId);
          draft.messages = graph.messages;
          draft.rootNodeId = graph.rootNodeId;
        });
      },

      setMessageHidden(sessionId: string, messageId: string, hidden: boolean) {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return;
        get().updateTargetSession(session, (draft) => {
          const message = draft.messages.find((item) => item.id === messageId);
          if (message) message.hidden = hidden;
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
          if (!message || message.deletedAt) return;
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
      checkMcpJson(message: ChatMessage) {
        const mcpEnabled = isMcpEnabled();
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
                  return get().onUserInput(
                    `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    [],
                    true,
                  );
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },
    };

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
        session.globalMemory ??= createEmptyGlobalMemory();
        if (session.messages.length > 0) {
          session.rootNodeId ??= session.messages[0]?.id;
          session.activeCursorId ??= session.messages.at(-1)?.id;
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
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
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
          migrateSessionToConversationGraph(session);
        });
      }

      return newState as any;
    },
  },
);
