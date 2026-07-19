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
  ConversationNode,
  NodeSummaryKind,
} from "./node";
export {
  createConversationNode,
  createMessage,
  createSourceDigest,
} from "./node";
export type { ConversationGraphState, GlobalMemory } from "./graph";

export interface ConversationApi extends ConversationGraphApi {
  readonly summaries: ConversationSummaryApi;
  readonly context: ConversationContextApi;
  planning(nodeId: string): ConversationPlanningApi;
}

function bindConversation(state: ConversationGraphState): ConversationApi {
  const graph = ConversationGraph(state);
  return Object.assign(graph, {
    summaries: ConversationSummary(graph.state),
    context: ConversationContext(graph.state),
    planning(nodeId: string) {
      return ConversationPlanning(graph.projectTo(nodeId), nodeId);
    },
  });
}

export const Conversation = Object.assign(bindConversation, {
  createMemory: ConversationGraph.createMemory,
});
