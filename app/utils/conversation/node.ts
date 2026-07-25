import { nanoid } from "nanoid";
import type { DEFAULT_MODELS } from "../../constant";
import { hash } from "../hmac";

export const CONVERSATION_ROLES = ["system", "user", "assistant"] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export interface ConversationMultimodalContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export type ConversationContent = string | ConversationMultimodalContent[];

export interface ConversationMessageInput {
  role: ConversationRole;
  content: ConversationContent;
}

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

export type ChatMessage = ConversationMessageInput & {
  date: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: (typeof DEFAULT_MODELS)[number]["name"];
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
};

export type NodeSummaryKind = "segment" | "checkpoint";
export type NodeSummaryProvenance = "generated" | "user-edited";

export interface NodeSummary {
  content: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  provenance: NodeSummaryProvenance;
}

export interface ConversationNode extends ChatMessage {
  parentId?: string;
  outlineLevel: number;
  activeBranchRootId?: string;
  nodeSummaries?: Partial<Record<NodeSummaryKind, NodeSummary>>;
}

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export function createConversationNode(
  override: Partial<ConversationNode>,
): ConversationNode {
  return {
    ...createMessage(override),
    outlineLevel: override.outlineLevel ?? 1,
    parentId: override.parentId,
    activeBranchRootId: override.activeBranchRootId,
    nodeSummaries: override.nodeSummaries,
  };
}

export function createSourceDigest(nodes: readonly ConversationNode[]) {
  return hash(
    JSON.stringify(nodes.map((node) => [node.id, node.role, node.content])),
  );
}
