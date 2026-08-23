import type { ClientApi } from "../client/api";
import { requestText } from "../client/request-text";
import type { ServiceProviderName } from "../constant";
import { getContextInputBudget } from "../utils/context-budget";
import { Conversation } from "../utils/conversation";
import type { ModelConfig } from "./config";
import { Mask } from "./mask";

export interface SummaryMaintenanceSession extends Conversation.State {
  id: string;
  mask: Pick<Mask, "modelConfig" | "plugin">;
}

export interface SummaryMaintenanceCommand {
  sessionId: string;
  targetNodeId: string;
  force?: boolean;
  onlyKind?: Conversation.SummaryKind;
}

export interface SummaryMaintenanceDependencies {
  getSession(sessionId: string): SummaryMaintenanceSession | undefined;
  updateConversation(
    sessionId: string,
    updater: (conversation: Conversation.Api) => Conversation.Api | undefined,
  ): void;
  createClient(providerName: ServiceProviderName): ClientApi;
  resolveDefaultModel(
    currentModel: string,
    providerName: ServiceProviderName,
  ): [model: string, providerName: ServiceProviderName];
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
  messages: Conversation.MessageInput[],
  modelConfig: ModelConfig,
  model: string,
  providerName: ServiceProviderName,
  summaryPrompt: string,
) {
  const content = await requestText(
    api,
    messages.concat(
      Conversation.createMessage({
        role: "system",
        content: summaryPrompt,
        date: "",
      }),
    ),
    { ...modelConfig, model },
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
        : Conversation(session).summaries.plan(target.id).segment({
            tokenTarget: modelConfig.segmentTargetSourceTokens,
            itemTarget: modelConfig.segmentMaxSourceNodes,
            inputBudget,
            force: command.force,
          });
    const [model, providerName] =
      modelConfig.compressModel && modelConfig.compressProviderName
        ? [modelConfig.compressModel, modelConfig.compressProviderName]
        : dependencies.resolveDefaultModel(modelConfig.model, modelConfig.providerName);

    if (segmentPlan) {
      const content = await requestSummary(
        dependencies.createClient(providerName),
        segmentPlan.inputs.map((input) => input.message),
        modelConfig,
        model,
        providerName,
        dependencies.summaryPrompt,
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
      .summaries.plan(checkpointTarget.id)
      .checkpoint({
        tokenTarget: modelConfig.checkpointMergeTargetTokens,
        itemTarget: modelConfig.checkpointTargetSegments,
        inputBudget,
        force: command.force,
      });
    if (!checkpointPlan) return;

    const content = await requestSummary(
      dependencies.createClient(providerName),
      checkpointPlan.inputs.map((input) => input.message),
      modelConfig,
      model,
      providerName,
      dependencies.summaryPrompt,
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

      const conversation = Conversation(initialSession);
      let chainRoot = initialTarget;
      while (chainRoot.parentId) {
        const parent = conversation.findNode(chainRoot.parentId)?.value;
        if (!parent || parent.outlineLevel !== chainRoot.outlineLevel) break;
        chainRoot = parent;
      }
      // The lock follows the Outline Chain lifecycle, while plans stay free of scheduler metadata.
      const jobKey = `${command.sessionId}:${chainRoot.id}`;
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
