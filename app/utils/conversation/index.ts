import {
  ConversationGraph,
  type ConversationGraphApi,
  type ConversationGraphState,
} from "./graph";
import { ConversationContext, type ConversationContextApi } from "./context";
import { ConversationPlanning, type ConversationPlanningApi } from "./planning";
import { ConversationSummary, type ConversationSummaryApi } from "./summary";

export type {
  ChatMessage,
  ChatMessageTool,
  ConversationContent,
  ConversationMessageInput,
  ConversationMultimodalContent,
  ConversationNode,
  ConversationRole,
  NodeSummaryKind,
} from "./node";
export {
  CONVERSATION_ROLES,
  createConversationNode,
  createMessage,
  createSourceDigest,
} from "./node";
export type { ConversationGraphState, GlobalMemory } from "./graph";
export type {
  ConversationContextAssembly,
  ConversationContextAssemblyOptions,
  ConversationContextEntry,
} from "./context";

type ConversationNodeData = Omit<
  import("./node").ConversationNode,
  "id" | "parentId" | "outlineLevel" | "activeBranchRootId" | "nodeSummaries"
>;

export interface ConversationApi extends ConversationGraphApi<ConversationApi> {
  readonly summaries: ConversationSummaryApi<ConversationApi>;
  readonly context: ConversationContextApi;
  moveCursor(nodeId?: string): ConversationApi;
  updateNodeData(
    nodeId: string,
    updater: (node: ConversationNodeData) => void,
  ): ConversationApi;
  planning(nodeId: string): ConversationPlanningApi;
}

function bindConversation(
  state: ConversationGraphState,
  validateStructure = false,
): ConversationApi {
  let conversation: ConversationApi;
  const graph = ConversationGraph(state, (next) =>
    bindConversation(next, true),
  );

  conversation = Object.assign(graph, {
    summaries: ConversationSummary(graph, bindConversation),
    context: ConversationContext(graph),
    moveCursor(nodeId?: string) {
      if (nodeId && !graph.projectActive().some((node) => node.id === nodeId)) {
        throw new Error(
          "Conversation cursor must stay in the active projection",
        );
      }
      return bindConversation({ ...graph.state, activeCursorId: nodeId });
    },
    updateNodeData(
      nodeId: string,
      updater: (node: ConversationNodeData) => void,
    ) {
      const current = graph.findNode(nodeId)?.value;
      if (!current) return conversation;
      const next = structuredClone(current);
      updater(next);
      return bindConversation({
        ...graph.state,
        messages: graph.state.messages.map((node) =>
          node.id === nodeId ? next : node,
        ),
      });
    },
    planning(nodeId: string) {
      return ConversationPlanning(graph.projectTo(nodeId), nodeId);
    },
  });
  if (validateStructure) conversation.validate();
  return conversation;
}

export const Conversation = Object.assign(bindConversation, {
  createMemory: ConversationGraph.createMemory,
});
