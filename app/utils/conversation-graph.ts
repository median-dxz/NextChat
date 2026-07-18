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
  summaryAttemptedAt?: number;
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
  let deletedUserBlocksAssistant = false;
  return messages.flatMap((message) => {
    if (message.deletedAt) {
      if (message.role === "user") deletedUserBlocksAssistant = true;
      return [];
    }
    if (message.role === "user") deletedUserBlocksAssistant = false;
    if (message.role === "assistant" && deletedUserBlocksAssistant) return [];

    const node: ConversationNode = {
      ...message,
      parentId,
      outlineLevel: 1,
      activeBranchRootId: undefined,
    };
    parentId = node.id;
    return [node];
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

function completeGraphMutation(
  _graph: ConversationGraphState,
  messages: ConversationNode[],
  rootNodeId: string | undefined,
  activeCursorId: string | undefined,
): ConversationGraphState {
  const next = { messages, rootNodeId, activeCursorId };
  validateConversationGraph(next);
  return next;
}

function replaceNodes(
  nodes: ConversationNode[],
  replacements: Map<string, ConversationNode>,
) {
  return nodes.map((node) => replacements.get(node.id) ?? node);
}

export function setActiveConversationBranch(
  graph: ConversationGraphState,
  parentId: string,
  branchRootId?: string,
): ConversationGraphState {
  const index = validateConversationGraph(graph);
  const parent = index.nodesById.get(parentId);
  if (!parent) throw new Error(`Missing branch parent ${parentId}`);
  if (branchRootId) {
    const branch = index.nodesById.get(branchRootId);
    if (
      !branch ||
      branch.parentId !== parent.id ||
      branch.outlineLevel !== parent.outlineLevel + 1
    ) {
      throw new Error(`Node ${branchRootId} is not a branch of ${parentId}`);
    }
  }

  const messages = graph.messages.map((node) =>
    node.id === parentId ? { ...node, activeBranchRootId: branchRootId } : node,
  );
  const activeCursorId = graph.activeCursorId;
  const candidate = completeGraphMutation(
    graph,
    messages,
    graph.rootNodeId,
    activeCursorId,
  );
  if (projectConversationToCursor(candidate).length > 0) return candidate;
  if (!branchRootId) return { ...candidate, activeCursorId: undefined };

  const candidateIndex = createConversationGraphIndex(candidate.messages);
  let branchTail = candidateIndex.nodesById.get(branchRootId)!;
  let successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);
  while (successor) {
    branchTail = successor;
    successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);
  }
  return completeGraphMutation(
    candidate,
    candidate.messages,
    candidate.rootNodeId,
    branchTail.id,
  );
}

export function insertConversationNode(
  graph: ConversationGraphState,
  input: ConversationNode,
  outlineDelta: -1 | 0 | 1 = 0,
  anchorId = graph.activeCursorId,
): ConversationGraphState {
  const index = validateConversationGraph(graph);
  if (index.nodesById.has(input.id)) {
    throw new Error(`Duplicate conversation node id: ${input.id}`);
  }
  if (graph.messages.length === 0) {
    if (outlineDelta !== 0) {
      throw new Error("The first conversation node must start at level 1");
    }
    const root = { ...input, parentId: undefined, outlineLevel: 1 };
    return completeGraphMutation(graph, [root], root.id, root.id);
  }
  if (!anchorId) throw new Error("Select a continuation node first");
  const anchor = index.nodesById.get(anchorId);
  if (!anchor) throw new Error(`Missing insertion anchor ${anchorId}`);
  if (!projectActiveConversation(graph).some((node) => node.id === anchor.id)) {
    throw new Error("Cannot insert from an inactive conversation branch");
  }

  let attachmentParent = anchor;
  if (outlineDelta === -1) {
    const targetLevel = anchor.outlineLevel - 1;
    if (targetLevel < 1)
      throw new Error("Conversation outline cannot go below 1");
    while (
      attachmentParent.outlineLevel > targetLevel &&
      attachmentParent.parentId
    ) {
      attachmentParent = index.nodesById.get(attachmentParent.parentId)!;
    }
    if (attachmentParent.outlineLevel !== targetLevel) {
      throw new Error(`No ancestor exists at outline level ${targetLevel}`);
    }
  }

  const replacements = new Map<string, ConversationNode>();
  const node: ConversationNode = {
    ...input,
    parentId: attachmentParent.id,
    outlineLevel:
      outlineDelta === 1
        ? attachmentParent.outlineLevel + 1
        : attachmentParent.outlineLevel,
  };

  if (outlineDelta === 1) {
    replacements.set(attachmentParent.id, {
      ...attachmentParent,
      activeBranchRootId: node.id,
    });
  } else {
    const successor = index.sameLevelChildByParentId.get(attachmentParent.id);
    if (successor) {
      replacements.set(successor.id, { ...successor, parentId: node.id });
    }
  }

  const messages = [...replaceNodes(graph.messages, replacements), node];
  return completeGraphMutation(graph, messages, graph.rootNodeId, node.id);
}

export function insertProjectedConversationNode(
  graph: ConversationGraphState,
  input: ConversationNode,
  previousId?: string,
  nextId?: string,
): ConversationGraphState {
  const projection = projectActiveConversation(graph);
  const previousIndex = previousId
    ? projection.findIndex((node) => node.id === previousId)
    : -1;
  const nextIndex = nextId
    ? projection.findIndex((node) => node.id === nextId)
    : projection.length;
  if (
    (previousId && previousIndex < 0) ||
    (nextId && nextIndex < 0) ||
    nextIndex - previousIndex !== 1
  ) {
    throw new Error("Inserted nodes must target adjacent projected positions");
  }

  if (!previousId && nextId) {
    const next = projection[nextIndex];
    if (next.id !== graph.rootNodeId || next.outlineLevel !== 1) {
      throw new Error("Only the root can be preceded by a new node");
    }
    const root = { ...input, parentId: undefined, outlineLevel: 1 };
    const oldRoot = { ...next, parentId: root.id };
    return completeGraphMutation(
      graph,
      [
        ...graph.messages.map((node) => (node.id === next.id ? oldRoot : node)),
        root,
      ],
      root.id,
      root.id,
    );
  }
  if (!previousId) return insertConversationNode(graph, input);

  const index = createConversationGraphIndex(graph.messages);
  const previous = index.nodesById.get(previousId)!;
  const next = nextId ? index.nodesById.get(nextId)! : undefined;
  const targetLevel = next
    ? Math.min(previous.outlineLevel, next.outlineLevel)
    : previous.outlineLevel;
  let attachmentParent = previous;
  while (
    attachmentParent.outlineLevel > targetLevel &&
    attachmentParent.parentId
  ) {
    attachmentParent = index.nodesById.get(attachmentParent.parentId)!;
  }

  let inserted = insertConversationNode(
    { ...graph, activeCursorId: attachmentParent.id },
    input,
    0,
    attachmentParent.id,
  );
  if (next && next.outlineLevel > targetLevel) {
    inserted = completeGraphMutation(
      inserted,
      inserted.messages.map((node) => {
        if (node.id === attachmentParent.id) {
          return { ...node, activeBranchRootId: undefined };
        }
        if (node.id === input.id) {
          return { ...node, activeBranchRootId: next.id };
        }
        if (node.id === next.id) return { ...node, parentId: input.id };
        return node;
      }),
      inserted.rootNodeId,
      input.id,
    );
  }
  return inserted;
}

function getSameLevelChain(
  index: ConversationGraphIndex,
  node: ConversationNode,
) {
  let root = node;
  while (root.parentId) {
    const parent = index.nodesById.get(root.parentId)!;
    if (parent.outlineLevel !== root.outlineLevel) break;
    root = parent;
  }
  const chain: ConversationNode[] = [];
  let current: ConversationNode | undefined = root;
  while (current) {
    chain.push(current);
    current = index.sameLevelChildByParentId.get(current.id);
  }
  return chain;
}

export function swapConversationNodes(
  graph: ConversationGraphState,
  firstId: string,
  secondId: string,
): ConversationGraphState {
  const index = validateConversationGraph(graph);
  const first = index.nodesById.get(firstId);
  const second = index.nodesById.get(secondId);
  if (!first || !second) throw new Error("Cannot swap missing nodes");
  if (first.outlineLevel !== second.outlineLevel) {
    throw new Error("Only nodes at the same outline level can be swapped");
  }
  const chain = getSameLevelChain(index, first);
  const firstIndex = chain.findIndex((node) => node.id === firstId);
  const secondIndex = chain.findIndex((node) => node.id === secondId);
  if (firstIndex < 0 || secondIndex < 0) {
    throw new Error("Only nodes in the same outline chain can be swapped");
  }

  const oldRoot = chain[0];
  const reordered = chain.slice();
  [reordered[firstIndex], reordered[secondIndex]] = [
    reordered[secondIndex],
    reordered[firstIndex],
  ];
  const replacements = new Map<string, ConversationNode>();
  reordered.forEach((node, position) => {
    replacements.set(node.id, {
      ...node,
      parentId: position === 0 ? oldRoot.parentId : reordered[position - 1].id,
    });
  });

  let rootNodeId = graph.rootNodeId;
  if (graph.rootNodeId === oldRoot.id) rootNodeId = reordered[0].id;
  if (oldRoot.parentId) {
    const owner = index.nodesById.get(oldRoot.parentId)!;
    if (owner.activeBranchRootId === oldRoot.id) {
      replacements.set(owner.id, {
        ...owner,
        activeBranchRootId: reordered[0].id,
      });
    }
  }
  return completeGraphMutation(
    graph,
    replaceNodes(graph.messages, replacements),
    rootNodeId,
    graph.activeCursorId,
  );
}

function collectSubtreeIds(index: ConversationGraphIndex, rootId: string) {
  const collected = new Set<string>();
  const visit = (nodeId: string) => {
    if (collected.has(nodeId)) return;
    collected.add(nodeId);
    for (const child of index.childrenByParentId.get(nodeId) ?? []) {
      visit(child.id);
    }
  };
  visit(rootId);
  return collected;
}

export function deleteConversationNode(
  graph: ConversationGraphState,
  nodeId: string,
): ConversationGraphState {
  const index = validateConversationGraph(graph);
  const node = index.nodesById.get(nodeId);
  if (!node) return graph;
  const parent = node.parentId ? index.nodesById.get(node.parentId) : undefined;
  const isBranchRoot = parent && node.outlineLevel === parent.outlineLevel + 1;
  const removed = isBranchRoot
    ? collectSubtreeIds(index, node.id)
    : new Set([node.id]);
  if (!isBranchRoot) {
    for (const child of index.childrenByParentId.get(node.id) ?? []) {
      if (child.outlineLevel > node.outlineLevel) {
        for (const id of collectSubtreeIds(index, child.id)) removed.add(id);
      }
    }
  }
  const replacements = new Map<string, ConversationNode>();

  if (!isBranchRoot) {
    const sameLevelSuccessor = index.sameLevelChildByParentId.get(node.id);
    if (sameLevelSuccessor) {
      removed.delete(sameLevelSuccessor.id);
      replacements.set(sameLevelSuccessor.id, {
        ...sameLevelSuccessor,
        parentId: node.parentId,
      });
    }
  }
  if (parent?.activeBranchRootId === node.id) {
    replacements.set(parent.id, { ...parent, activeBranchRootId: undefined });
  }

  const messages = replaceNodes(
    graph.messages.filter((candidate) => !removed.has(candidate.id)),
    replacements,
  );
  const rootNodeId =
    graph.rootNodeId === node.id
      ? messages.find((candidate) => !candidate.parentId)?.id
      : graph.rootNodeId;
  const activeCursorId =
    graph.activeCursorId && removed.has(graph.activeCursorId)
      ? undefined
      : graph.activeCursorId;
  return completeGraphMutation(graph, messages, rootNodeId, activeCursorId);
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
