import type { ClientApi } from "../client/api";
import { requestText } from "../client/request-text";
import type { ServiceProviderName } from "../constant";
import { getContextInputBudget } from "../utils/context-budget";
import { Conversation } from "../utils/conversation";
import type { SummaryMaintenancePlan } from "../utils/conversation/summary";
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

type GenerationCommand = Omit<SummaryMaintenanceCommand, "sessionId">;

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
  generate(
    session: SummaryMaintenanceSession,
    command: GenerationCommand,
    readConversation: () => Conversation.Api | undefined,
    receive: (
      nodeId: string,
      kind: Conversation.SummaryKind,
      summary: Conversation.Summary,
    ) => void,
  ): Promise<void>;
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

  const run = async (
    session: SummaryMaintenanceSession,
    command: GenerationCommand,
    readConversation: () => Conversation.Api | undefined,
    receive: (plan: SummaryMaintenancePlan, content: string, source: Conversation.Api) => void,
  ) => {
    const conversation = readConversation();
    if (!conversation) return;

    const target = conversation.findNode(command.targetNodeId)?.value;
    if (!target || target.role !== "assistant") return;

    const modelConfig = session.mask.modelConfig;
    const inputBudget = getContextInputBudget(
      modelConfig.contextWindowTokens,
      modelConfig.max_tokens,
    );

    const segmentPlan =
      command.onlyKind === "checkpoint"
        ? undefined
        : conversation.summaries.plan(target.id).segment({
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

      if (!readConversation()) return;
      receive(segmentPlan, content, conversation);
    }

    if (command.onlyKind === "segment") return;

    const checkpointConversation = readConversation();
    if (!checkpointConversation) return;

    const checkpointPlan = checkpointConversation.summaries.plan(command.targetNodeId).checkpoint({
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

    if (!readConversation()) return;
    receive(checkpointPlan, content, checkpointConversation);
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
        .then(async () => {
          const session = dependencies.getSession(command.sessionId);
          if (!session) return;

          await run(
            session,
            command,
            () => {
              const latest = dependencies.getSession(command.sessionId);
              return latest ? Conversation(latest) : undefined;
            },
            (plan, content) => {
              dependencies.updateConversation(command.sessionId, (conversation) =>
                conversation.summaries.commitGenerated(plan, content),
              );
            },
          );
        })
        .finally(() => {
          if (jobs.get(jobKey)?.promise === execution) jobs.delete(jobKey);
        });

      jobs.set(jobKey, {
        targetNodeId: command.targetNodeId,
        promise: execution,
      });

      return execution;
    },

    generate(session, command, readConversation, receive) {
      return run(session, command, readConversation, (plan, content, source) => {
        // Draft generation keeps the request's source; background maintain validates the latest state.
        const accepted = source.summaries.commitGenerated(plan, content);
        if (!accepted) throw new Error("Summary generation does not match its request snapshot");

        const summary = accepted.node(plan.target.nodeId).value.nodeSummaries![plan.target.kind]!;
        receive(plan.target.nodeId, plan.target.kind, summary);
      });
    },
  };
}
