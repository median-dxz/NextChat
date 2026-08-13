import type { ClientApi } from "../client/api";
import { requestText, toModelInputMessages } from "../client/request-text";
import { getContextInputBudget } from "../utils/context-budget";
import {
  Conversation,
  createMessage,
  type ChatMessage,
  type ConversationApi,
  type ConversationGraphState,
  type NodeSummaryKind,
} from "../utils/conversation";
import type { ModelConfig } from "./config";
import { Mask } from "./mask";

export interface SummaryMaintenanceSession extends ConversationGraphState {
  id: string;
  mask: Pick<Mask, "modelConfig" | "plugin">;
}

export interface SummaryMaintenanceCommand {
  sessionId: string;
  targetNodeId: string;
  force?: boolean;
  onlyKind?: NodeSummaryKind;
}

export interface SummaryMaintenanceDependencies {
  getSession(sessionId: string): SummaryMaintenanceSession | undefined;
  updateConversation(
    sessionId: string,
    updater: (conversation: ConversationApi) => ConversationApi | undefined,
  ): void;
  getClientApi(providerName?: string): ClientApi;
  resolveDefaultModel(
    currentModel: string,
    providerName: string,
  ): [model: string, providerName: string];
  summaryPrompt: string;
}

export interface SummaryMaintenance {
  maintain(command: SummaryMaintenanceCommand): Promise<void>;
}

interface SummaryJob {
  targetNodeId: string;
  promise: Promise<void>;
}

async function requestSummary(
  api: ClientApi,
  messages: ChatMessage[],
  modelConfig: ModelConfig,
  model: string,
  providerName: string,
  summaryPrompt: string,
  pluginIds: string[],
) {
  const content = await requestText(
    api,
    toModelInputMessages(
      messages.concat(
        createMessage({
          role: "system",
          content: summaryPrompt,
          date: "",
        }),
      ),
    ),
    { ...modelConfig, model, providerName },
    pluginIds,
  );
  if (!content) {
    throw new Error(`Summary request returned empty content (${providerName}/${model})`);
  }
  return content;
}

export function createSummaryMaintenance(
  dependencies: SummaryMaintenanceDependencies,
): SummaryMaintenance {
  const jobs = new Map<string, SummaryJob>();

  const run = async (command: SummaryMaintenanceCommand) => {
    const session = dependencies.getSession(command.sessionId);
    const target = session?.messages.find((node) => node.id === command.targetNodeId);
    if (!session || !target || target.role !== "assistant") return;

    const modelConfig = session.mask.modelConfig;
    const inputBudget = getContextInputBudget(
      modelConfig.contextWindowTokens,
      modelConfig.max_tokens,
    );
    const segmentPlan =
      command.onlyKind === "checkpoint"
        ? undefined
        : Conversation(session).planning(target.id).segment({
            sourceTokenTarget: modelConfig.segmentTargetSourceTokens,
            maxSourceNodes: modelConfig.segmentMaxSourceNodes,
            inputBudget,
            force: command.force,
          });
    const [model, providerName] = modelConfig.compressModel
      ? [modelConfig.compressModel, modelConfig.compressProviderName]
      : dependencies.resolveDefaultModel(modelConfig.model, modelConfig.providerName);

    if (segmentPlan) {
      const content = await requestSummary(
        dependencies.getClientApi(providerName),
        [
          ...segmentPlan.background.map((background) =>
            background.kind === "segment"
              ? createMessage({
                  role: "assistant",
                  content: background.content ?? "",
                  date: "",
                })
              : background.node!,
          ),
          ...segmentPlan.sourceNodes,
        ],
        modelConfig,
        model,
        providerName,
        dependencies.summaryPrompt,
        session.mask.plugin ?? [],
      );
      dependencies.updateConversation(command.sessionId, (conversation) =>
        conversation.summaries.commitGenerated(segmentPlan, content),
      );
    }

    if (command.onlyKind === "segment") return;

    const checkpointSession = dependencies.getSession(command.sessionId);
    const checkpointTarget = checkpointSession?.messages.find(
      (node) => node.id === command.targetNodeId,
    );
    if (!checkpointSession || !checkpointTarget) return;
    const checkpointPlan = Conversation(checkpointSession)
      .planning(checkpointTarget.id)
      .checkpoint({
        targetSegments: modelConfig.checkpointTargetSegments,
        mergeTokenTarget: modelConfig.checkpointMergeTargetTokens,
        inputBudget,
        force: command.force,
      });
    if (!checkpointPlan) return;

    const content = await requestSummary(
      dependencies.getClientApi(providerName),
      checkpointPlan.inputs.map((input) =>
        createMessage({
          role: "assistant",
          content: input.content,
          date: "",
        }),
      ),
      modelConfig,
      model,
      providerName,
      dependencies.summaryPrompt,
      checkpointSession.mask.plugin ?? [],
    );
    dependencies.updateConversation(command.sessionId, (conversation) =>
      conversation.summaries.commitGenerated(checkpointPlan, content),
    );
  };

  return {
    maintain(command) {
      const initialSession = dependencies.getSession(command.sessionId);
      const initialTarget = initialSession?.messages.find(
        (node) => node.id === command.targetNodeId,
      );
      if (!initialSession || !initialTarget || initialTarget.role !== "assistant") {
        return Promise.resolve();
      }

      const chainRootId = Conversation(initialSession).planning(command.targetNodeId).chainRootId;
      if (!chainRootId) return Promise.resolve();

      const jobKey = `${command.sessionId}:${chainRootId}`;
      const pending = jobs.get(jobKey);
      if (pending?.targetNodeId === command.targetNodeId) {
        return pending.promise;
      }

      const previous = pending?.promise ?? Promise.resolve();
      let execution: Promise<void>;
      execution = previous
        .catch(() => undefined)
        .then(() => run(command))
        .finally(() => {
          if (jobs.get(jobKey)?.promise === execution) jobs.delete(jobKey);
        });
      jobs.set(jobKey, {
        targetNodeId: command.targetNodeId,
        promise: execution,
      });
      return execution;
    },
  };
}
