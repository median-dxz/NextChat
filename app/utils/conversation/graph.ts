import { createSourceDigest, type ConversationNode } from "./node";

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

export interface ConversationGraphNodeApi<TResult> {
  readonly value: ConversationNode;
  readonly parent: ConversationNode | undefined;
  readonly sameLevelSuccessor: ConversationNode | undefined;
  readonly branches: ConversationNode[];

  shiftLevel(outlineDelta: -1 | 0 | 1): TResult;
  selectBranch(branchRootId?: string): TResult;
  remove(): TResult;
}

export interface ConversationGraphApi<TResult> {
  readonly state: ConversationGraphState;

  validate(): void;
  projectActive(): ConversationNode[];
  projectToCursor(): ConversationNode[];
  projectTo(nodeId: string): ConversationNode[];
  node(nodeId: string): ConversationGraphNodeApi<TResult>;
  findNode(nodeId: string): ConversationGraphNodeApi<TResult> | undefined;
  insert(
    input: ConversationNode,
    outlineDelta?: -1 | 0 | 1,
    anchorId?: string,
  ): TResult;
  insertProjected(
    input: ConversationNode,
    previousId?: string,
    nextId?: string,
  ): TResult;
  swap(firstId: string, secondId: string): TResult;
  clone(createId: () => string): {
    conversation: TResult;
    ids: Map<string, string>;
  };
}

const createMemory = (): GlobalMemory => {
  return {
    enabled: false,
    prompt: "",
    content: "",
    revision: 0,
  };
};

function buildIndex(nodes: ConversationNode[]): ConversationGraphIndex {
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

function validate(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
) {
  if (graph.messages.length === 0) {
    if (graph.rootNodeId || graph.activeCursorId) {
      throw new Error("Empty conversation graph cannot have root or cursor");
    }
    return;
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
}

function shiftLevel(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  nodeId: string,
  outlineDelta: -1 | 0 | 1 = 0,
): ConversationGraphState {
  const target = index.nodesById.get(nodeId);
  if (!target) {
    throw new Error(`Missing conversation node ${nodeId}`);
  }
  if (outlineDelta === 0) return graph;
  if (!target.parentId) {
    throw new Error("The root node cannot change outline level");
  }

  const parent = index.nodesById.get(target.parentId)!;
  const targetLevel = target.outlineLevel + outlineDelta;
  if (
    targetLevel !== parent.outlineLevel &&
    targetLevel !== parent.outlineLevel + 1
  ) {
    throw new Error("Invalid outline level change");
  }

  const subtreeIds = new Set<string>();
  const visit = (id: string) => {
    subtreeIds.add(id);
    for (const child of index.childrenByParentId.get(id) ?? []) visit(child.id);
  };

  visit(target.id);

  return completeGraphMutation(graph, {
    messages: graph.messages.map((node) =>
      subtreeIds.has(node.id)
        ? { ...node, outlineLevel: node.outlineLevel + outlineDelta }
        : node,
    ),
  });
}

function projectActive(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
) {
  if (!graph.rootNodeId) return [];

  const result: ConversationNode[] = [];

  const visit = (nodeId: string) => {
    const node = index.nodesById.get(nodeId)!;
    result.push(node);

    if (node.activeBranchRootId) visit(node.activeBranchRootId);
    const sameLevelChild = index.sameLevelChildByParentId.get(node.id);
    if (sameLevelChild) visit(sameLevelChild.id);
  };

  visit(graph.rootNodeId);
  return result;
}

function projectToCursor(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
) {
  if (!graph.activeCursorId) return [];
  const projection = projectActive(graph, index);
  const cursorIndex = projection.findIndex(
    (node) => node.id === graph.activeCursorId,
  );
  return cursorIndex < 0 ? [] : projection.slice(0, cursorIndex + 1);
}

function completeGraphMutation(
  graph: ConversationGraphState,
  override?: Partial<ConversationGraphState>,
) {
  return { ...graph, ...override };
}

function replaceNodes(
  nodes: ConversationNode[],
  replacements: Map<string, ConversationNode>,
) {
  return nodes.map((node) => replacements.get(node.id) ?? node);
}

function setBranch(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  parentId: string,
  branchRootId?: string,
): ConversationGraphState {
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

  const candidate = completeGraphMutation(graph, {
    messages: graph.messages.map((node) =>
      node.id === parentId
        ? { ...node, activeBranchRootId: branchRootId }
        : node,
    ),
  });

  if (projectToCursor(candidate, buildIndex(candidate.messages)).length > 0) {
    return candidate;
  }

  if (!branchRootId) {
    return completeGraphMutation(candidate, { activeCursorId: undefined });
  }

  let branchTail = index.nodesById.get(branchRootId)!;
  let successor = index.sameLevelChildByParentId.get(branchTail.id);
  while (successor) {
    branchTail = successor;
    successor = index.sameLevelChildByParentId.get(branchTail.id);
  }
  return completeGraphMutation(candidate, { activeCursorId: branchTail.id });
}

function insert(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  input: ConversationNode,
  outlineDelta: -1 | 0 | 1 = 0,
  anchorId = graph.activeCursorId,
): ConversationGraphState {
  if (index.nodesById.has(input.id)) {
    throw new Error(`Duplicate conversation node id: ${input.id}`);
  }

  if (graph.messages.length === 0) {
    if (outlineDelta !== 0) {
      throw new Error("The first conversation node must start at level 1");
    }

    const root = { ...input, parentId: undefined, outlineLevel: 1 };
    return completeGraphMutation(graph, {
      messages: [root],
      rootNodeId: root.id,
      activeCursorId: root.id,
    });
  }

  if (!anchorId) throw new Error("Select a continuation node first");

  const anchor = index.nodesById.get(anchorId);
  if (!anchor) throw new Error(`Missing insertion anchor ${anchorId}`);

  if (!projectActive(graph, index).some((node) => node.id === anchor.id)) {
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

  return completeGraphMutation(graph, {
    messages: [...replaceNodes(graph.messages, replacements), node],
    activeCursorId: node.id,
  });
}

function insertProjected(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  input: ConversationNode,
  previousId?: string,
  nextId?: string,
): ConversationGraphState {
  const projection = projectActive(graph, index);
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
    return completeGraphMutation(graph, {
      messages: [
        ...graph.messages.map((node) => (node.id === next.id ? oldRoot : node)),
        root,
      ],
      rootNodeId: root.id,
      activeCursorId: root.id,
    });
  }
  if (!previousId) return insert(graph, index, input);

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

  let inserted = insert(
    { ...graph, activeCursorId: attachmentParent.id },
    index,
    input,
    0,
    attachmentParent.id,
  );
  if (next && next.outlineLevel > targetLevel) {
    inserted = completeGraphMutation(inserted, {
      messages: inserted.messages.map((node) => {
        if (node.id === attachmentParent.id) {
          return { ...node, activeBranchRootId: undefined };
        }
        if (node.id === input.id) {
          return { ...node, activeBranchRootId: next.id };
        }
        if (node.id === next.id) return { ...node, parentId: input.id };
        return node;
      }),
      activeCursorId: input.id,
    });
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

function swap(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  firstId: string,
  secondId: string,
): ConversationGraphState {
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

  return completeGraphMutation(graph, {
    messages: replaceNodes(graph.messages, replacements),
    rootNodeId,
  });
}

function collectSubtreeIds(index: ConversationGraphIndex, rootId: string) {
  const collected = new Set<string>();
  const visit = (nodeId: string) => {
    collected.add(nodeId);
    for (const child of index.childrenByParentId.get(nodeId) ?? []) {
      visit(child.id);
    }
  };
  visit(rootId);
  return collected;
}

function remove(
  graph: ConversationGraphState,
  index: ConversationGraphIndex,
  nodeId: string,
): ConversationGraphState {
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
  return completeGraphMutation(graph, { messages, rootNodeId, activeCursorId });
}

function clone(graph: ConversationGraphState, createId: () => string) {
  const cloned = structuredClone(graph);
  const ids = new Map<string, string>();

  for (const node of cloned.messages) {
    ids.set(node.id, createId());
  }

  const remapId = (id?: string) => (id === undefined ? undefined : ids.get(id));

  for (const node of cloned.messages) {
    node.id = remapId(node.id)!;
    node.parentId = remapId(node.parentId);
    node.activeBranchRootId = remapId(node.activeBranchRootId);

    for (const summary of Object.values(node.nodeSummaries ?? {})) {
      if (!summary) continue;
      summary.sourceNodeIds = summary.sourceNodeIds
        .map(remapId)
        .filter((id): id is string => Boolean(id));
    }
  }

  cloned.rootNodeId = remapId(cloned.rootNodeId);
  cloned.activeCursorId = remapId(cloned.activeCursorId);

  const nodesById = new Map(cloned.messages.map((node) => [node.id, node]));
  for (const node of cloned.messages) {
    for (const summary of Object.values(node.nodeSummaries ?? {})) {
      if (!summary) continue;
      const sources = summary.sourceNodeIds
        .map((id) => nodesById.get(id))
        .filter((source): source is ConversationNode => Boolean(source));

      summary.sourceDigest = createSourceDigest(sources);
    }
  }

  return { graph: cloned, ids };
}

function bindConversationGraph<TResult>(
  graph: ConversationGraphState,
  commit: (state: ConversationGraphState) => TResult,
): ConversationGraphApi<TResult> {
  const state: ConversationGraphState = {
    messages: graph.messages,
    rootNodeId: graph.rootNodeId,
    activeCursorId: graph.activeCursorId,
  };
  let cachedIndex: ConversationGraphIndex | undefined;
  let isValidated = false;

  const getIndex = () => (cachedIndex ??= buildIndex(state.messages));
  const getValidatedIndex = () => {
    const index = getIndex();
    if (!isValidated) {
      validate(state, index);
      isValidated = true;
    }
    return index;
  };

  const findNode = (
    nodeId: string,
  ): ConversationGraphNodeApi<TResult> | undefined => {
    const index = getIndex();
    const value = index.nodesById.get(nodeId);
    if (!value) return undefined;

    return {
      value,
      get parent() {
        return value.parentId ? index.nodesById.get(value.parentId) : undefined;
      },
      get sameLevelSuccessor() {
        return index.sameLevelChildByParentId.get(value.id);
      },
      get branches() {
        return (index.childrenByParentId.get(value.id) ?? []).filter(
          (child) => child.outlineLevel === value.outlineLevel + 1,
        );
      },
      shiftLevel: (...args) =>
        commit(shiftLevel(state, getValidatedIndex(), value.id, ...args)),
      selectBranch: (...args) =>
        commit(setBranch(state, getValidatedIndex(), value.id, ...args)),
      remove: () => commit(remove(state, getValidatedIndex(), value.id)),
    };
  };

  return {
    state,
    validate() {
      getValidatedIndex();
    },
    projectActive: () => projectActive(state, getValidatedIndex()),
    projectToCursor: () => projectToCursor(state, getValidatedIndex()),
    projectTo: (nodeId) =>
      projectToCursor(
        { ...state, activeCursorId: nodeId },
        getValidatedIndex(),
      ),
    node: (nodeId) => {
      const node = findNode(nodeId);
      if (!node) throw new Error(`Missing conversation node ${nodeId}`);
      return node;
    },
    findNode,
    insert: (...args) => commit(insert(state, getValidatedIndex(), ...args)),
    insertProjected: (...args) =>
      commit(insertProjected(state, getValidatedIndex(), ...args)),
    swap: (...args) => commit(swap(state, getValidatedIndex(), ...args)),
    clone: (...args) => {
      const { graph: cloned, ids } = clone(state, ...args);
      return { conversation: commit(cloned), ids };
    },
  };
}

export const ConversationGraph = Object.assign(bindConversationGraph, {
  createMemory,
});
