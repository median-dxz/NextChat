import type { ModelInputMessage } from "../../client/api";
import {
  estimateRequestMessageTokens,
  getContextInputBudget,
  getEffectiveMaxOutputTokens,
} from "../context-budget";
import { type ConversationGraphApi } from "./graph";
import type { ConversationMessageInput, ConversationNode } from "./node";
import {
  planNodeConversationContext,
  type ContextRepresentation,
} from "./planning";

export interface ConversationContextBuildOptions {
  availableTokens: number;
  recentRawNodeCount: number;
  summaries: "enabled" | "disabled";
  cursorId?: string;
  excludeNodeId?: string;
}

export interface ConversationContextAssemblyOptions {
  systemInputs: ConversationMessageInput[];
  pinnedInputs: ConversationMessageInput[];
  globalMemoryInput?: ConversationMessageInput;
  currentInput: ConversationMessageInput & { id?: string };
  budget: {
    contextWindowTokens: number;
    requestedOutputTokens: number;
  };
  recentRawNodeCount: number;
  summaries: "enabled" | "disabled";
  cursorId?: string;
}

export type ConversationContextEntry =
  | {
      kind: "raw";
      nodeId: string;
      role: ConversationNode["role"];
      content: ConversationNode["content"];
    }
  | Extract<ContextRepresentation, { kind: "segment" | "checkpoint" }>;

export interface ConversationContextAssembly {
  messages: ModelInputMessage[];
  effectiveMaxOutputTokens: number;
}

function toModelInputRole(role: ConversationMessageInput["role"]) {
  if (role === "system") return "instruction";
  if (role === "assistant") return "model";
  return "user";
}

function toModelInputMessage(
  entry: ConversationMessageInput | ConversationContextEntry,
): ModelInputMessage {
  if (!("kind" in entry)) {
    return {
      role: toModelInputRole(entry.role),
      content: entry.content,
    };
  }
  if (entry.kind === "raw") {
    return {
      role: toModelInputRole(entry.role),
      content: entry.content,
    };
  }
  return { role: "model", content: entry.content };
}

function availableToCursor(
  graph: ConversationGraphApi<unknown>,
  options: Pick<ConversationContextBuildOptions, "cursorId" | "excludeNodeId">,
) {
  const projection = options.cursorId
    ? graph.projectTo(options.cursorId)
    : graph.projectToCursor();
  const isAvailable = (node: ConversationNode | undefined) =>
    Boolean(node && !node.isError && !node.streaming);

  return projection.filter((node) => {
    if (node.id === options.excludeNodeId || !isAvailable(node)) return false;
    if (node.role !== "assistant" || !node.parentId) return true;
    const parent = graph.findNode(node.parentId)?.value;
    return parent?.role !== "user" || isAvailable(parent);
  });
}

function materializeNeutralEntries(
  projection: ConversationNode[],
  representations: ContextRepresentation[],
): ConversationContextEntry[] {
  const nodesById = new Map(projection.map((node) => [node.id, node]));
  const projectionOrder = new Map(
    projection.map((node, index) => [node.id, index]),
  );
  const selected: Array<{
    order: number;
    entry: ConversationContextEntry;
  }> = [];

  for (const representation of representations) {
    const raw = representation.kind === "raw";
    const endpointId = raw
      ? representation.nodeId
      : representation.sourceNodeIds.at(-1);
    const order = endpointId ? projectionOrder.get(endpointId) : undefined;
    if (order === undefined) continue;
    const node = raw ? nodesById.get(representation.nodeId) : undefined;
    if (raw && !node) continue;
    selected.push({
      order,
      entry: raw
        ? {
            kind: "raw",
            nodeId: node!.id,
            role: node!.role,
            content: node!.content,
          }
        : representation,
    });
  }

  return selected
    .sort((left, right) => left.order - right.order)
    .map(({ entry }) => entry);
}

export function ConversationContext(graph: ConversationGraphApi<unknown>) {
  return {
    build(options: ConversationContextBuildOptions) {
      const projection = availableToCursor(graph, options);
      const plan = planNodeConversationContext({
        projection,
        recentRawNodeCount: options.recentRawNodeCount,
        availableTokens: options.availableTokens,
        includeSummaries: options.summaries === "enabled",
      });
      return {
        entries: materializeNeutralEntries(projection, plan.representations),
        diagnostics: plan.diagnostics,
        tokens: plan.tokens,
      };
    },

    assemble(options: ConversationContextAssemblyOptions) {
      const fixedMessages = [
        ...options.systemInputs,
        ...(options.globalMemoryInput ? [options.globalMemoryInput] : []),
        ...options.pinnedInputs,
      ];
      const inputBudget = getContextInputBudget(
        options.budget.contextWindowTokens,
        options.budget.requestedOutputTokens,
      );
      const fixedTokenCount = fixedMessages.reduce(
        (sum, message) => sum + estimateRequestMessageTokens(message),
        0,
      );
      const currentInputTokenCount = estimateRequestMessageTokens(
        options.currentInput,
      );
      if (fixedTokenCount + currentInputTokenCount > inputBudget) {
        throw new Error(
          "System prompts and current input exceed the context window",
        );
      }
      const availableHistoryTokens = Math.max(
        0,
        inputBudget - fixedTokenCount - currentInputTokenCount,
      );
      const history = this.build({
        availableTokens: availableHistoryTokens,
        recentRawNodeCount: options.recentRawNodeCount,
        summaries: options.summaries,
        cursorId: options.cursorId,
        excludeNodeId: options.currentInput.id,
      });
      const inputTokenCount =
        fixedTokenCount + history.tokens + currentInputTokenCount;

      const messages = [
        ...fixedMessages.map(toModelInputMessage),
        ...history.entries.map(toModelInputMessage),
        toModelInputMessage(options.currentInput),
      ];

      return {
        messages,
        effectiveMaxOutputTokens: getEffectiveMaxOutputTokens(
          options.budget.contextWindowTokens,
          options.budget.requestedOutputTokens,
          inputTokenCount,
        ),
      } satisfies ConversationContextAssembly;
    },
  };
}

export type ConversationContextApi = ReturnType<typeof ConversationContext>;
