import type { ChatMessage } from "../store/chat";
import type { NodeSummary, NodeSummaryKind } from "./node-summary";

export interface ConversationNode extends ChatMessage {
  parentId?: string;
  outlineLevel: number;
  activeBranchRootId?: string;
  nodeSummaries?: Partial<Record<NodeSummaryKind, NodeSummary>>;
}
