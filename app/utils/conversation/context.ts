import type { RequestMessage } from "../../client/api";
import { ConversationGraph, type ConversationGraphState } from "./graph";
import type { ConversationNode } from "./node";
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

export function materializeContextRepresentations(
  projection: ConversationNode[],
  representations: ContextRepresentation[],
): RequestMessage[] {
  const nodesById = new Map(projection.map((node) => [node.id, node]));
  const projectionOrder = new Map(
    projection.map((node, index) => [node.id, index]),
  );
  const selected: Array<{ order: number; message: RequestMessage }> = [];
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
      message: raw
        ? { role: node!.role, content: node!.content }
        : { role: "assistant", content: representation.content },
    });
  }
  return selected
    .sort((left, right) => left.order - right.order)
    .map(({ message }) => message);
}

export function ConversationContext(state: ConversationGraphState) {
  const graph = ConversationGraph(state);
  const availableToCursor = (options: ConversationContextBuildOptions) => {
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
  };

  return {
    build(options: ConversationContextBuildOptions) {
      const projection = availableToCursor(options);
      const planningProjection =
        options.summaries === "enabled"
          ? projection
          : projection.map((node) => ({
              ...node,
              nodeSummaries: undefined,
            }));
      const plan = planNodeConversationContext({
        projection: planningProjection,
        recentRawNodeCount: options.recentRawNodeCount,
        availableTokens: options.availableTokens,
      });
      return materializeContextRepresentations(
        planningProjection,
        plan.representations,
      );
    },
  };
}

export type ConversationContextApi = ReturnType<typeof ConversationContext>;
