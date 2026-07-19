import { nanoid } from "nanoid";
import type {
  ChatOptions,
  ClientApi,
  MultimodalContent,
  RequestMessage,
} from "../client/api";
import { getProviderContextAdapter } from "../client/provider-context";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
} from "../constant";
import { getLang } from "../locales";
import { getAllTools, isMcpEnabled } from "../mcp/actions";
import { prettyObject } from "../utils/format";
import {
  Conversation,
  createConversationNode,
  createMessage,
  type ChatMessageTool,
  type ConversationGraphState,
  type ConversationNode,
  type GlobalMemory,
} from "../utils/conversation";
import type { ModelConfig } from "./config";

export interface ChatOrchestratorSession extends ConversationGraphState {
  id: string;
  pendingOutlineDelta?: -1 | 1;
  pinnedInputs: RequestMessage[];
  globalMemory: GlobalMemory;
  mask: { modelConfig: ModelConfig };
}

export interface ChatRunCommand {
  sessionId: string;
  content: string;
  attachImages?: string[];
  isMcpResponse?: boolean;
  retry?: { sourceNodeId: string };
}

export type ChatRunResult =
  | {
      status: "completed";
      sessionId: string;
      userNodeId: string;
      assistantNodeId: string;
    }
  | {
      status: "cancelled";
      sessionId: string;
      userNodeId: string;
      assistantNodeId: string;
    }
  | {
      status: "failed";
      sessionId: string;
      userNodeId: string;
      assistantNodeId: string;
      error: Error;
    };

export interface ChatRunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly userNodeId: string;
  readonly assistantNodeId: string;
  cancel(): void;
  readonly completion: Promise<ChatRunResult>;
}

export interface AssistantCommitted {
  sessionId: string;
  userNodeId: string;
  assistantNodeId: string;
}

export interface ChatCompletionEffects {
  dispatch(event: AssistantCommitted): void;
}

export interface ChatOrchestratorDependencies {
  getSession(sessionId: string): ChatOrchestratorSession | undefined;
  updateSession(
    sessionId: string,
    updater: (session: ChatOrchestratorSession) => void,
  ): void;
  getClientApi(providerName?: string): ClientApi;
  completionEffects: ChatCompletionEffects;
}

export interface ChatOrchestrator {
  start(command: ChatRunCommand): Promise<ChatRunHandle>;
  activeRuns(): readonly ChatRunHandle[];
  cancel(sessionId: string, assistantNodeId: string): void;
  cancelAll(): void;
}

type ProviderRunResult =
  | { status: "completed"; message: string }
  | { status: "cancelled" }
  | { status: "failed"; error: Error };

interface ProviderRun {
  cancel(): void;
  completion: Promise<ProviderRunResult>;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function startProviderRun(
  api: ClientApi,
  options: Omit<ChatOptions, "onFinish"> & {
    onFinish?: ChatOptions["onFinish"];
  },
): ProviderRun {
  let controller: AbortController | undefined;
  let cancelRequested = false;
  let settled = false;
  let resolveCompletion!: (result: ProviderRunResult) => void;
  const completion = new Promise<ProviderRunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const settle = (result: ProviderRunResult) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };

  try {
    const invocation = api.llm.chat({
      ...options,
      onFinish(message, response) {
        options.onFinish?.(message, response);
        settle(
          cancelRequested
            ? { status: "cancelled" }
            : { status: "completed", message },
        );
      },
      onError(error) {
        options.onError?.(error);
        settle(
          cancelRequested
            ? { status: "cancelled" }
            : { status: "failed", error: asError(error) },
        );
      },
      onController(nextController) {
        controller = nextController;
        options.onController?.(nextController);
        if (cancelRequested) nextController.abort();
      },
    });
    void Promise.resolve(invocation).catch((error) => {
      settle(
        cancelRequested
          ? { status: "cancelled" }
          : { status: "failed", error: asError(error) },
      );
    });
  } catch (error) {
    settle({ status: "failed", error: asError(error) });
  }

  return {
    cancel() {
      if (settled) return;
      cancelRequested = true;
      controller?.abort();
      settle({ status: "cancelled" });
    },
    completion,
  };
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  const modelInfo = DEFAULT_MODELS.find(
    (model) => model.name === modelConfig.model,
  );
  const serviceProvider = modelInfo?.provider.providerName ?? "OpenAI";
  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input,
  };
  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;
  if (input.startsWith(output)) output = "";
  if (!output.includes("{{input}}")) output += "\n{{input}}";
  Object.entries(vars).forEach(([name, value]) => {
    output = output.replace(new RegExp(`{{${name}}}`, "g"), value.toString());
  });
  return output;
}

async function getMcpSystemPrompt() {
  const tools = await getAllTools();
  let toolsText = "";
  tools.forEach((client) => {
    if (!client.tools) return;
    toolsText += MCP_TOOLS_TEMPLATE.replace(
      "{{ clientId }}",
      client.clientId,
    ).replace(
      "{{ tools }}",
      client.tools.tools
        .map((tool: object) => JSON.stringify(tool, null, 2))
        .join("\n"),
    );
  });
  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsText);
}

async function resolveSystemInputs(modelConfig: ModelConfig) {
  const shouldInjectSystemPrompts =
    modelConfig.enableInjectSystemPrompts &&
    (modelConfig.model.startsWith("gpt-") ||
      modelConfig.model.startsWith("chatgpt-"));
  const mcpEnabled = await isMcpEnabled();
  const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";
  if (shouldInjectSystemPrompts) {
    return [
      createMessage({
        role: "system",
        content:
          fillTemplateWith("", {
            ...modelConfig,
            template: DEFAULT_SYSTEM_TEMPLATE,
          }) + mcpSystemPrompt,
      }),
    ];
  }
  return mcpEnabled
    ? [createMessage({ role: "system", content: mcpSystemPrompt })]
    : [];
}

function prepareInput(
  command: ChatRunCommand,
  modelConfig: ModelConfig,
  retrySource?: ConversationNode,
) {
  if (retrySource) return retrySource.content;
  if (command.isMcpResponse) return command.content;
  if (command.attachImages?.length) {
    return [
      ...(command.content
        ? [{ type: "text" as const, text: command.content }]
        : []),
      ...command.attachImages.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ] satisfies MultimodalContent[];
  }
  return fillTemplateWith(command.content, modelConfig);
}

function prepareRetryGraph(
  session: ChatOrchestratorSession,
  sourceNodeId: string,
) {
  const targetNode = Conversation(session).findNode(sourceNodeId);
  if (!targetNode) throw new Error("Retry source no longer exists");
  const target = targetNode.value;
  if (target.role === "assistant") {
    const user = targetNode.parent;
    if (!user || user.role !== "user") {
      throw new Error("An assistant retry requires its direct user node");
    }
    return {
      graph: { ...targetNode.remove(), activeCursorId: user.id },
      source: { ...user },
      reuseUser: true,
      insertBeforeId: undefined,
    };
  }

  const response = targetNode.sameLevelSuccessor;
  let graph = targetNode.remove();
  if (response?.role === "assistant") {
    const responseNode = Conversation(graph).findNode(response.id);
    if (responseNode) graph = responseNode.remove();
  }
  graph = { ...graph, activeCursorId: target.parentId };
  Conversation(graph).validate();
  return {
    graph,
    source: { ...target },
    reuseUser: false,
    insertBeforeId: target.parentId ? undefined : graph.rootNodeId,
  };
}

export function createChatOrchestrator(
  dependencies: ChatOrchestratorDependencies,
): ChatOrchestrator {
  const active = new Map<string, ChatRunHandle>();

  const updateNode = (
    sessionId: string,
    nodeId: string,
    updater: (node: ConversationNode) => void,
  ) => {
    dependencies.updateSession(sessionId, (session) => {
      const node = session.messages.find((message) => message.id === nodeId);
      if (node) updater(node);
    });
  };

  return {
    async start(command) {
      const initialSession = dependencies.getSession(command.sessionId);
      if (!initialSession) throw new Error("Chat session no longer exists");
      const modelConfig = initialSession.mask.modelConfig;
      const systemInputs = await resolveSystemInputs(modelConfig);
      const session = dependencies.getSession(command.sessionId);
      if (!session) throw new Error("Chat session no longer exists");

      const retry = command.retry
        ? prepareRetryGraph(session, command.retry.sourceNodeId)
        : undefined;
      const content = prepareInput(command, modelConfig, retry?.source);
      const userNode = retry?.reuseUser
        ? retry.source
        : createConversationNode({
            role: "user",
            content,
            isMcpResponse: retry?.source.isMcpResponse ?? command.isMcpResponse,
          });
      const assistantNode = createConversationNode({
        role: "assistant",
        streaming: true,
        model: modelConfig.model,
      });
      const contextState = retry?.graph ?? session;
      const globalMemoryInput =
        session.globalMemory.enabled && session.globalMemory.content.trim()
          ? createMessage({
              role: "system",
              content: session.globalMemory.content,
              date: "",
            })
          : undefined;
      const assembly = Conversation(contextState).context.assemble({
        systemInputs,
        pinnedInputs: session.pinnedInputs,
        globalMemoryInput,
        currentInput: userNode,
        budget: {
          contextWindowTokens: modelConfig.contextWindowTokens,
          requestedOutputTokens: modelConfig.max_tokens,
        },
        recentRawNodeCount: modelConfig.recentRawNodeCount,
        summaries: modelConfig.sendMemory ? "enabled" : "disabled",
      });
      const messages = getProviderContextAdapter(
        modelConfig.providerName,
      ).materialize(assembly.entries);

      let committedGraph: ConversationGraphState = contextState;
      if (!retry?.reuseUser) {
        committedGraph = retry?.insertBeforeId
          ? Conversation(committedGraph).insertProjected(
              userNode,
              undefined,
              retry.insertBeforeId,
            )
          : Conversation(committedGraph).insert(
              userNode,
              session.pendingOutlineDelta ?? 0,
            );
      }
      committedGraph = Conversation(committedGraph).insert(
        assistantNode,
        0,
        userNode.id,
      );
      const committedUser = committedGraph.messages.find(
        (node) => node.id === userNode.id,
      )!;
      const committedAssistant = committedGraph.messages.find(
        (node) => node.id === assistantNode.id,
      )!;
      dependencies.updateSession(command.sessionId, (draft) => {
        draft.messages = committedGraph.messages;
        draft.rootNodeId = committedGraph.rootNodeId;
        draft.activeCursorId = committedGraph.activeCursorId;
        draft.pendingOutlineDelta = undefined;
      });

      const runId = nanoid();
      let reasoningStartedAt: number | undefined;
      const finishReasoningTiming = () => {
        if (reasoningStartedAt === undefined) return;
        updateNode(command.sessionId, committedAssistant.id, (node) => {
          node.reasoningDurationMs ??= Math.max(
            0,
            Date.now() - reasoningStartedAt!,
          );
        });
      };
      const api = dependencies.getClientApi(modelConfig.providerName);
      const providerRun = startProviderRun(api, {
        messages,
        config: {
          ...modelConfig,
          max_tokens: assembly.effectiveMaxOutputTokens,
          stream: true,
        },
        onUpdate(message) {
          if (message) finishReasoningTiming();
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            node.streaming = true;
            if (message) node.content = message;
          });
        },
        onReasoningUpdate(reasoning) {
          reasoningStartedAt ??= Date.now();
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            node.streaming = true;
            node.reasoning = reasoning;
          });
        },
        onBeforeTool(tool: ChatMessageTool) {
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            (node.tools ??= []).push(tool);
          });
        },
        onAfterTool(tool: ChatMessageTool) {
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            const index = node.tools?.findIndex((item) => item.id === tool.id);
            if (index !== undefined && index >= 0 && node.tools) {
              node.tools[index] = { ...tool };
            }
          });
        },
      });

      const completion = providerRun.completion.then((providerResult) => {
        active.delete(runId);
        finishReasoningTiming();
        if (providerResult.status === "completed") {
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            node.streaming = false;
            node.content = providerResult.message;
            node.date = new Date().toLocaleString();
          });
          try {
            dependencies.completionEffects.dispatch({
              sessionId: command.sessionId,
              userNodeId: committedUser.id,
              assistantNodeId: committedAssistant.id,
            });
          } catch (error) {
            console.error("[Chat Completion Effects]", error);
          }
          return {
            status: "completed" as const,
            sessionId: command.sessionId,
            userNodeId: committedUser.id,
            assistantNodeId: committedAssistant.id,
          };
        }
        if (providerResult.status === "cancelled") {
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            node.streaming = false;
          });
          return {
            status: "cancelled" as const,
            sessionId: command.sessionId,
            userNodeId: committedUser.id,
            assistantNodeId: committedAssistant.id,
          };
        }

        updateNode(command.sessionId, committedUser.id, (node) => {
          node.isError = true;
        });
        updateNode(command.sessionId, committedAssistant.id, (node) => {
          node.content +=
            "\n\n" +
            prettyObject({
              error: true,
              message: providerResult.error.message,
            });
          node.streaming = false;
          node.isError = true;
        });
        return {
          status: "failed" as const,
          sessionId: command.sessionId,
          userNodeId: committedUser.id,
          assistantNodeId: committedAssistant.id,
          error: providerResult.error,
        };
      });
      const handle: ChatRunHandle = {
        runId,
        sessionId: command.sessionId,
        userNodeId: committedUser.id,
        assistantNodeId: committedAssistant.id,
        cancel: () => providerRun.cancel(),
        completion,
      };
      active.set(runId, handle);
      return handle;
    },

    activeRuns() {
      return Array.from(active.values());
    },

    cancel(sessionId, assistantNodeId) {
      active.forEach((run) => {
        if (
          run.sessionId === sessionId &&
          run.assistantNodeId === assistantNodeId
        ) {
          run.cancel();
        }
      });
    },

    cancelAll() {
      active.forEach((run) => run.cancel());
    },
  };
}
