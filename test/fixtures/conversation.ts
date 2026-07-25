import { ServiceProvider } from "../../app/constant";
import type { ModelConfig } from "../../app/store/config";
import {
  Conversation,
  createConversationNode,
  createSourceDigest,
  type ChatMessage,
  type ConversationGraphState,
  type ConversationNode,
} from "../../app/utils/conversation";

export const TEST_MODEL_CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  providerName: ServiceProvider.OpenAI,
  temperature: 0.5,
  top_p: 1,
  max_tokens: 4000,
  contextWindowTokens: 32000,
  presence_penalty: 0,
  frequency_penalty: 0,
  sendMemory: true,
  recentRawNodeCount: 4,
  segmentTargetSourceTokens: 1000,
  segmentMaxSourceNodes: 16,
  checkpointTargetSegments: 4,
  checkpointMergeTargetTokens: 1000,
  compressModel: "",
  compressProviderName: "",
  memoryModel: "",
  memoryProviderName: "",
  titleModel: "",
  titleProviderName: "",
  enableInjectSystemPrompts: false,
  template: "{{input}}",
  size: "1024x1024",
  quality: "standard",
  style: "vivid",
};

export function conversationNode(
  input: Pick<ConversationNode, "id" | "role"> & Partial<ConversationNode>,
): ConversationNode {
  return createConversationNode({
    date: "",
    content: input.id,
    outlineLevel: 1,
    ...input,
  });
}

export function linearConversation(
  messages: Array<
    Pick<ChatMessage, "role"> & Partial<Omit<ConversationNode, "role">>
  >,
): ConversationGraphState {
  let parentId: string | undefined;
  const nodes = messages.map((message, index) => {
    const node = conversationNode({
      id: message.id ?? `${message.role}-${index}`,
      content: message.content ?? `${message.role} ${index}`,
      outlineLevel: message.outlineLevel ?? 1,
      parentId,
      ...message,
      role: message.role,
    });
    parentId = node.id;
    return node;
  });
  return conversationState(nodes);
}

export function conversationState(
  messages: ConversationNode[],
  overrides: Partial<ConversationGraphState> = {},
): ConversationGraphState {
  return {
    messages,
    rootNodeId: messages[0]?.id,
    activeCursorId: messages.at(-1)?.id,
    ...overrides,
  };
}

export function generatedSummary(
  sourceNodes: ConversationNode[],
  content = "summary",
  provenance: "generated" | "user-edited" = "generated",
) {
  return {
    content,
    sourceNodeIds: sourceNodes.map((node) => node.id),
    sourceDigest: createSourceDigest(sourceNodes),
    provenance,
  } as const;
}

export function chatSession(
  graph: ConversationGraphState = conversationState([]),
  options: {
    id?: string;
    modelConfig?: Partial<ModelConfig>;
    pendingOutlineDelta?: -1 | 1;
    pinnedInputs?: ChatMessage[];
    pluginIds?: string[];
  } = {},
) {
  return {
    ...graph,
    id: options.id ?? "session",
    pendingOutlineDelta: options.pendingOutlineDelta,
    pinnedInputs: options.pinnedInputs ?? [],
    globalMemory: Conversation.createMemory(),
    mask: {
      modelConfig: { ...TEST_MODEL_CONFIG, ...options.modelConfig },
      plugin: options.pluginIds ?? [],
    },
  };
}
