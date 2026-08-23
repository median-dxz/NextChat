import { nanoid } from "nanoid";
import type { ChatOptions, ChatTools, ClientApi, MultimodalContent } from "../client/api";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
  ServiceProvider,
  type ServiceProviderName,
} from "../constant";
import { getLang } from "../locales";
import { getAllTools, isMcpEnabled } from "../mcp/actions";
import { prettyObject } from "../utils/format";
import { Conversation } from "../utils/conversation";
import type { ModelConfig } from "./config";
import { Mask } from "./mask";

export interface ChatOrchestratorSession extends Conversation.State {
  id: string;
  pendingOutlineDelta?: -1 | 1;
  pinnedInputs: Conversation.MessageInput[];
  globalMemory: Conversation.GlobalMemory;
  mask: Pick<Mask, "modelConfig" | "plugin">;
}

export type ChatRunCommand =
  | {
      kind: "input";
      sessionId: string;
      content: string;
      attachImages?: string[];
      isMcpResponse?: boolean;
    }
  | {
      kind: "retry";
      sessionId: string;
      sourceNodeId: string;
    };

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
    updater: (
      session: Pick<ChatOrchestratorSession, "pendingOutlineDelta"> & {
        conversation: Conversation.Api;
      },
    ) => void | false,
  ): void;
  createClient(providerName: ServiceProviderName): ClientApi;
  resolveTools(pluginIds: string[]): ChatTools | undefined;
  completionEffects: ChatCompletionEffects;
}

type NodeUpdater = Parameters<Conversation.Api["updateNodeData"]>[1];

export interface ChatOrchestrator {
  /** Starts a new chat run based on the provided command. */
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
        settle(cancelRequested ? { status: "cancelled" } : { status: "completed", message });
      },
      onError(error) {
        options.onError?.(error);
        settle(
          cancelRequested ? { status: "cancelled" } : { status: "failed", error: asError(error) },
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
        cancelRequested ? { status: "cancelled" } : { status: "failed", error: asError(error) },
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
  const cutoff = KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  const modelInfo = DEFAULT_MODELS.find((model) => model.name === modelConfig.model);
  const serviceProvider = modelInfo?.provider.providerName ?? ServiceProvider.OpenAI;
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
    toolsText += MCP_TOOLS_TEMPLATE.replace("{{ clientId }}", client.clientId).replace(
      "{{ tools }}",
      client.tools.tools.map((tool: object) => JSON.stringify(tool, null, 2)).join("\n"),
    );
  });
  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsText);
}

async function resolveSystemInputs(modelConfig: ModelConfig) {
  const shouldInjectSystemPrompts =
    modelConfig.enableInjectSystemPrompts &&
    (modelConfig.model.startsWith("gpt-") || modelConfig.model.startsWith("chatgpt-"));
  const mcpEnabled = await isMcpEnabled();
  const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";
  if (shouldInjectSystemPrompts) {
    return [
      Conversation.createMessage({
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
    ? [Conversation.createMessage({ role: "system", content: mcpSystemPrompt })]
    : [];
}

function prepareInput(
  command: Extract<ChatRunCommand, { kind: "input" }>,
  modelConfig: ModelConfig,
) {
  if (command.isMcpResponse) return command.content;
  if (command.attachImages?.length) {
    return [
      ...(command.content ? [{ type: "text" as const, text: command.content }] : []),
      ...command.attachImages.map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
    ] satisfies MultimodalContent[];
  }
  return fillTemplateWith(command.content, modelConfig);
}

export function createChatOrchestrator(
  dependencies: ChatOrchestratorDependencies,
): ChatOrchestrator {
  const active = new Map<string, ChatRunHandle>();

  const updateNode = (sessionId: string, nodeId: string, updater: NodeUpdater) => {
    dependencies.updateSession(sessionId, (session) => {
      session.conversation = session.conversation.updateNodeData(nodeId, updater);
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

      let conversation = Conversation(session);
      let userNode: Conversation.Node;

      if (command.kind === "retry") {
        const source = conversation.node(command.sourceNodeId);
        const response = source.sameLevelSuccessor!;

        userNode = source.value;
        conversation = conversation.node(response.id).remove().moveCursor(userNode.id);
      } else {
        userNode = Conversation.createNode({
          role: "user",
          content: prepareInput(command, modelConfig),
          isMcpResponse: command.isMcpResponse,
        });

        const activeCursorId = conversation.state.activeCursorId;
        const cursor = activeCursorId ? conversation.node(activeCursorId).value : undefined;
        const outlineDelta = session.pendingOutlineDelta ?? 0;

        if (!cursor) {
          conversation = conversation.insert(userNode);
        } else if (outlineDelta === -1 && cursor.outlineLevel > 1) {
          let target = cursor;
          const targetLevel = target.outlineLevel - 1;
          while (target.outlineLevel > targetLevel) {
            target = conversation.node(target.parentId!).value;
          }
          conversation = conversation.moveCursor(target.id).insert(userNode);
        } else if (outlineDelta === 1) {
          conversation = conversation.node(cursor.id).setBranch(userNode).moveCursor(userNode.id);
        } else {
          conversation = conversation.insert(userNode);
        }
      }

      const assistantNode = Conversation.createNode({
        role: "assistant",
        streaming: true,
        model: modelConfig.model,
      });
      const globalMemoryInput =
        session.globalMemory.enabled && session.globalMemory.content.trim()
          ? Conversation.createMessage({
              role: "system",
              content: session.globalMemory.content,
              date: "",
            })
          : undefined;
      const assembly = conversation.context.assemble({
        systemInputs,
        pinnedInputs: session.pinnedInputs,
        globalMemoryInput,
        budget: {
          contextWindowTokens: modelConfig.contextWindowTokens,
          requestedOutputTokens: modelConfig.max_tokens,
        },
        recentRawNodeCount: modelConfig.recentRawNodeCount,
        summaries: modelConfig.enableConversationSummaries ? "enabled" : "disabled",
      });

      dependencies.updateSession(command.sessionId, (session) => {
        if (command.kind === "retry") {
          conversation = conversation.insertProjected(assistantNode, userNode.id);
        } else {
          conversation = conversation.insert(assistantNode);
        }

        session.conversation = conversation;
        if (command.kind === "input") {
          session.pendingOutlineDelta = undefined;
        }
      });

      const committedUser = conversation.node(userNode.id).value;
      const committedAssistant = conversation.node(assistantNode.id).value;

      const runId = nanoid();
      let reasoningStartedAt: number | undefined;
      const finishReasoningTiming = () => {
        if (reasoningStartedAt === undefined) return;
        updateNode(command.sessionId, committedAssistant.id, (node) => {
          node.reasoningDurationMs ??= Math.max(0, Date.now() - reasoningStartedAt!);
        });
      };
      const api = dependencies.createClient(modelConfig.providerName);
      const providerRun = startProviderRun(api, {
        messages: assembly.messages,
        config: {
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          top_p: modelConfig.top_p,
          max_tokens: assembly.effectiveMaxOutputTokens,
          presence_penalty: modelConfig.presence_penalty,
          frequency_penalty: modelConfig.frequency_penalty,
          stream: true,
          size: modelConfig.size,
          quality: modelConfig.quality,
          style: modelConfig.style,
        },
        tools: dependencies.resolveTools(session.mask.plugin ?? []),
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
        onBeforeTool(tool: Conversation.MessageTool) {
          updateNode(command.sessionId, committedAssistant.id, (node) => {
            (node.tools ??= []).push(tool);
          });
        },
        onAfterTool(tool: Conversation.MessageTool) {
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
        if (run.sessionId === sessionId && run.assistantNodeId === assistantNodeId) {
          run.cancel();
        }
      });
    },

    cancelAll() {
      active.forEach((run) => run.cancel());
    },
  };
}
