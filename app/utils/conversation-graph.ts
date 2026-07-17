import type { ChatMessage } from "../store/chat";

export type NodeSummaryKind = "segment" | "checkpoint";

export interface NodeSummary {
  content: string;
  sourceNodeIds: string[];
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationNode extends ChatMessage {
  parentId?: string;
  outlineLevel: number;
  activeBranchRootId?: string;
  hidden?: boolean;
  nodeSummaries?: Partial<Record<NodeSummaryKind, NodeSummary>>;
}

export interface GlobalMemory {
  enabled: boolean;
  prompt: string;
  content: string;
  revision: number;
}

export interface ConversationGraphState {
  messages: ConversationNode[];
  rootNodeId?: string;
  activeCursorId?: string;
}

export interface ConversationGraphIndex {
  nodesById: Map<string, ConversationNode>;
  childrenByParentId: Map<string, ConversationNode[]>;
  sameLevelChildByParentId: Map<string, ConversationNode>;
}

export function createEmptyGlobalMemory(): GlobalMemory {
  return {
    enabled: false,
    prompt: "",
    content: "",
    revision: 0,
  };
}

export function toLevelOneConversationNodes(
  messages: ChatMessage[],
): ConversationNode[] {
  let parentId: string | undefined;
  return messages
    .filter((message) => !message.deletedAt)
    .map((message) => {
      const node: ConversationNode = {
        ...message,
        parentId,
        outlineLevel: 1,
        activeBranchRootId: undefined,
      };
      parentId = node.id;
      return node;
    });
}

export function createConversationGraphIndex(
  nodes: ConversationNode[],
): ConversationGraphIndex {
  const nodesById = new Map<string, ConversationNode>();
  const childrenByParentId = new Map<string, ConversationNode[]>();
  const sameLevelChildByParentId = new Map<string, ConversationNode>();

  for (const node of nodes) {
    if (nodesById.has(node.id)) {
      throw new Error(`Duplicate conversation node id: ${node.id}`);
    }
    nodesById.set(node.id, node);
  }

  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = nodesById.get(node.parentId);
    if (!parent) {
      throw new Error(`Missing parent ${node.parentId} for node ${node.id}`);
    }
    if (
      node.outlineLevel !== parent.outlineLevel &&
      node.outlineLevel !== parent.outlineLevel + 1
    ) {
      throw new Error(
        `Invalid outline transition ${parent.outlineLevel} -> ${node.outlineLevel}`,
      );
    }
    const children = childrenByParentId.get(parent.id) ?? [];
    children.push(node);
    childrenByParentId.set(parent.id, children);
    if (node.outlineLevel === parent.outlineLevel) {
      if (sameLevelChildByParentId.has(parent.id)) {
        throw new Error(`Multiple same-level children for node ${parent.id}`);
      }
      sameLevelChildByParentId.set(parent.id, node);
    }
  }

  return { nodesById, childrenByParentId, sameLevelChildByParentId };
}

export function validateConversationGraph(
  graph: ConversationGraphState,
): ConversationGraphIndex {
  const index = createConversationGraphIndex(graph.messages);
  if (graph.messages.length === 0) {
    if (graph.rootNodeId || graph.activeCursorId) {
      throw new Error("Empty conversation graph cannot have root or cursor");
    }
    return index;
  }

  const roots = graph.messages.filter((node) => !node.parentId);
  if (roots.length !== 1 || roots[0].id !== graph.rootNodeId) {
    throw new Error("Conversation graph must have exactly one declared root");
  }
  if (graph.activeCursorId && !index.nodesById.has(graph.activeCursorId)) {
    throw new Error("Conversation graph cursor must reference a node");
  }

  for (const node of graph.messages) {
    if (!Number.isInteger(node.outlineLevel) || node.outlineLevel < 1) {
      throw new Error(`Invalid outline level for node ${node.id}`);
    }
    if (node.activeBranchRootId) {
      const branch = index.nodesById.get(node.activeBranchRootId);
      if (
        !branch ||
        branch.parentId !== node.id ||
        branch.outlineLevel !== node.outlineLevel + 1
      ) {
        throw new Error(`Invalid active branch for node ${node.id}`);
      }
    }

    const visited = new Set<string>();
    let current: ConversationNode | undefined = node;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        throw new Error(`Conversation graph contains a cycle at ${current.id}`);
      }
      visited.add(current.id);
      current = index.nodesById.get(current.parentId);
    }
    if (current?.id !== graph.rootNodeId) {
      throw new Error(`Node ${node.id} is not connected to the root`);
    }
  }

  return index;
}

export function projectActiveConversation(
  graph: ConversationGraphState,
): ConversationNode[] {
  if (!graph.rootNodeId) return [];
  const index = validateConversationGraph(graph);
  const result: ConversationNode[] = [];
  const visited = new Set<string>();

  const visit = (nodeId: string) => {
    if (visited.has(nodeId)) {
      throw new Error(`Active projection contains a cycle at ${nodeId}`);
    }
    const node = index.nodesById.get(nodeId);
    if (!node) throw new Error(`Missing projected node ${nodeId}`);
    visited.add(nodeId);
    result.push(node);

    if (node.activeBranchRootId) visit(node.activeBranchRootId);
    const sameLevelChild = index.sameLevelChildByParentId.get(node.id);
    if (sameLevelChild) visit(sameLevelChild.id);
  };

  visit(graph.rootNodeId);
  return result;
}

export function projectConversationToCursor(
  graph: ConversationGraphState,
): ConversationNode[] {
  if (!graph.activeCursorId) return [];
  const projection = projectActiveConversation(graph);
  const cursorIndex = projection.findIndex(
    (node) => node.id === graph.activeCursorId,
  );
  return cursorIndex < 0 ? [] : projection.slice(0, cursorIndex + 1);
}

export function remapConversationNodes(
  nodes: ConversationNode[],
  createId: () => string,
) {
  const ids = new Map(nodes.map((node) => [node.id, createId()]));
  const remapped = nodes.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    parentId: node.parentId ? ids.get(node.parentId) : undefined,
    activeBranchRootId: node.activeBranchRootId
      ? ids.get(node.activeBranchRootId)
      : undefined,
    nodeSummaries: node.nodeSummaries
      ? Object.fromEntries(
          Object.entries(node.nodeSummaries).map(([kind, summary]) => [
            kind,
            summary
              ? {
                  ...summary,
                  sourceNodeIds: summary.sourceNodeIds
                    .map((id) => ids.get(id))
                    .filter((id): id is string => Boolean(id)),
                }
              : undefined,
          ]),
        )
      : undefined,
  })) as ConversationNode[];
  return { nodes: remapped, ids };
}
