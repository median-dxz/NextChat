import { enableMapSet, produce } from "immer";
import { createCoverageDigest, type Node } from "./node";
import type { Workspace } from "./workspace";

enableMapSet();

export interface GlobalMemory {
  enabled: boolean;
  prompt: string;
  content: string;
  revision: number;
}

export interface State {
  messages: Node[];
  rootNodeId?: string;
  activeCursorId?: string;
}

export interface Index {
  nodesById: Map<string, Node>;
  positionById: Map<string, number>;
  childrenByParentId: Map<string, Node[]>;
  sameLevelChildByParentId: Map<string, Node>;
}

export interface NodeApi<TResult> {
  readonly value: Node;
  readonly parent: Node | undefined;
  readonly sameLevelSuccessor: Node | undefined;
  readonly branches: Node[];

  shiftLevel(outlineDelta: -1 | 0 | 1): TResult;
  setBranch(branch?: string | Node): TResult;
  remove(): TResult;
}

export interface Api<TResult> {
  readonly state: State;

  validate(): void;
  projectActive(): Node[];
  projectToCursor(): Node[];
  projectTo(nodeId: string): Node[];
  moveCursor(nodeId: string): TResult;
  node(nodeId: string): NodeApi<TResult>;
  findNode(nodeId: string): NodeApi<TResult> | undefined;
  insert(input: Node): TResult;
  /** Inserts after previousId in the active projection; undefined prepends. */
  insertProjected(input: Node, previousId?: string): TResult;
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

export function buildIndex(nodes: Node[]): Index {
  const nodesById = new Map<string, Node>();
  const positionById = new Map<string, number>();
  const childrenByParentId = new Map<string, Node[]>();
  const sameLevelChildByParentId = new Map<string, Node>();

  for (const [position, node] of nodes.entries()) {
    if (nodesById.has(node.id)) {
      throw new Error(`Duplicate conversation node id: ${node.id}`);
    }
    nodesById.set(node.id, node);
    positionById.set(node.id, position);
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
      throw new Error(`Invalid outline transition ${parent.outlineLevel} -> ${node.outlineLevel}`);
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

  return { nodesById, positionById, childrenByParentId, sameLevelChildByParentId };
}

export function validate(graph: State, index: Index) {
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
  if (roots[0].outlineLevel !== 1) {
    throw new Error("Conversation graph root must be at outline level 1");
  }
  if (!graph.activeCursorId || !index.nodesById.has(graph.activeCursorId)) {
    throw new Error("Conversation graph cursor must reference a node");
  }

  for (const node of graph.messages) {
    if (
      Array.isArray(node.content) &&
      node.content.some((part) =>
        part.type === "text"
          ? typeof part.text !== "string"
          : part.type === "image_url"
            ? typeof part.image_url?.url !== "string"
            : true,
      )
    ) {
      throw new Error(`Invalid conversation content for node ${node.id}`);
    }
    if (!Number.isInteger(node.outlineLevel) || node.outlineLevel < 1) {
      throw new Error(`Invalid outline level for node ${node.id}`);
    }
    if (node.activeBranchRootId) {
      const branch = index.nodesById.get(node.activeBranchRootId);
      if (!branch || branch.parentId !== node.id || branch.outlineLevel !== node.outlineLevel + 1) {
        throw new Error(`Invalid active branch for node ${node.id}`);
      }
    }
  }

  const colors = new Map<string, "visiting" | "visited">();
  const connectedToRoot = new Set<string>();
  const visit = (nodeId: string, connected: boolean) => {
    const color = colors.get(nodeId);
    if (color === "visiting") {
      throw new Error(`Conversation graph contains a cycle at ${nodeId}`);
    }
    if (color === "visited") return;

    colors.set(nodeId, "visiting");
    if (connected) connectedToRoot.add(nodeId);
    for (const child of index.childrenByParentId.get(nodeId) ?? []) {
      visit(child.id, connected);
    }
    colors.set(nodeId, "visited");
  };

  visit(graph.rootNodeId!, true);
  for (const node of graph.messages) visit(node.id, false);
  if (connectedToRoot.size !== graph.messages.length) {
    const disconnected = graph.messages.find((node) => !connectedToRoot.has(node.id))!;
    throw new Error(`Node ${disconnected.id} is not connected to the root`);
  }

  if (!projectActive(graph, index).some((node) => node.id === graph.activeCursorId)) {
    throw new Error("Conversation graph cursor must stay in the active projection");
  }
}

function shiftLevel(
  graph: State,
  index: Index,
  target: Node,
  parent: Node,
  outlineDelta: -1 | 1,
): State {
  const subtreeIds = new Set<string>();
  const visit = (id: string) => {
    subtreeIds.add(id);
    for (const child of index.childrenByParentId.get(id) ?? []) visit(child.id);
  };

  visit(target.id);

  let targetChainTail = target;
  let targetSuccessor = index.sameLevelChildByParentId.get(targetChainTail.id);

  while (targetSuccessor) {
    targetChainTail = targetSuccessor;
    targetSuccessor = index.sameLevelChildByParentId.get(targetChainTail.id);
  }

  const parentSuccessor = index.sameLevelChildByParentId.get(parent.id);

  const candidate = produce(graph, (draft) => {
    for (const nodeId of subtreeIds) {
      draft.messages[index.positionById.get(nodeId)!].outlineLevel += outlineDelta;
    }

    const draftParent = draft.messages[index.positionById.get(parent.id)!];

    if (outlineDelta === -1 && draftParent.activeBranchRootId === target.id) {
      draftParent.activeBranchRootId = undefined;
    } else if (outlineDelta === 1) {
      draftParent.activeBranchRootId = target.id;
    }

    if (outlineDelta === -1 && parentSuccessor) {
      draft.messages[index.positionById.get(parentSuccessor.id)!].parentId = targetChainTail.id;
    }
  });

  const candidateIndex = buildIndex(candidate.messages);

  if (projectActive(candidate, candidateIndex).some((node) => node.id === graph.activeCursorId)) {
    return candidate;
  }

  if (outlineDelta === -1) {
    return produce(candidate, (draft) => {
      draft.activeCursorId = parent.id;
    });
  }

  let branchTail = candidateIndex.nodesById.get(target.id)!;
  let successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);

  while (successor) {
    branchTail = successor;
    successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);
  }

  return produce(candidate, (draft) => {
    draft.activeCursorId = branchTail.id;
  });
}

export function projectActive(graph: State, index: Index) {
  if (!graph.rootNodeId) return [];

  const result: Node[] = [];

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

function setBranch(graph: State, index: Index, parent: Node, branch?: Node): State {
  const candidate = produce(graph, (draft) => {
    draft.messages[index.positionById.get(parent.id)!].activeBranchRootId = branch?.id;
  });

  const updatedParent = candidate.messages[index.positionById.get(parent.id)!];
  const nodesById = new Map(index.nodesById);
  nodesById.set(parent.id, updatedParent);

  const candidateIndex = { ...index, nodesById };

  if (projectActive(candidate, candidateIndex).some((node) => node.id === graph.activeCursorId)) {
    return candidate;
  }

  if (branch === undefined) {
    return produce(candidate, (draft) => {
      draft.activeCursorId = parent.id;
    });
  }

  let branchTail = branch;
  let successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);

  while (successor) {
    branchTail = successor;
    successor = candidateIndex.sameLevelChildByParentId.get(branchTail.id);
  }

  return produce(candidate, (draft) => {
    draft.activeCursorId = branchTail.id;
  });
}

function createBranch(graph: State, index: Index, parent: Node, branch: Node) {
  const candidate = produce(graph, (draft) => {
    draft.messages.push(branch);
  });

  const createdBranch = candidate.messages.at(-1)!;
  const candidateIndex = produce(index, (draft) => {
    draft.nodesById.set(createdBranch.id, createdBranch);
    draft.positionById.set(createdBranch.id, candidate.messages.length - 1);
    draft.childrenByParentId.set(parent.id, [
      ...(draft.childrenByParentId.get(parent.id) ?? []),
      createdBranch,
    ]);
  });

  return setBranch(candidate, candidateIndex, parent, createdBranch);
}

function createNode(input: Node, parent?: Node, outlineLevel = parent?.outlineLevel ?? 1): Node {
  return {
    ...input,
    parentId: parent?.id,
    outlineLevel,
    activeBranchRootId: undefined,
  };
}

function insert(graph: State, index: Index, node: Node, anchor?: Node): State {
  return produce(graph, (draft) => {
    if (!anchor) {
      draft.messages.push(node);
      draft.rootNodeId = node.id;
      draft.activeCursorId = node.id;
      return;
    }

    const successor = index.sameLevelChildByParentId.get(anchor.id);

    if (successor) {
      draft.messages[index.positionById.get(successor.id)!].parentId = node.id;
    }

    draft.messages.push(node);
    draft.activeCursorId = node.id;
  });
}

function insertProjected(graph: State, index: Index, input: Node, previous?: Node): State {
  const projection = projectActive(graph, index);
  const next = previous ? projection[projection.indexOf(previous) + 1] : projection[0];

  if (!previous) {
    const root = createNode(input);

    if (!next) return insert(graph, index, root);

    return produce(graph, (draft) => {
      draft.messages[index.positionById.get(next.id)!].parentId = root.id;
      draft.messages.push(root);
      draft.rootNodeId = root.id;
      draft.activeCursorId = root.id;
    });
  }

  const targetLevel = next
    ? Math.min(previous.outlineLevel, next.outlineLevel)
    : previous.outlineLevel;
  let attachmentParent = previous;

  while (attachmentParent.outlineLevel > targetLevel && attachmentParent.parentId) {
    attachmentParent = index.nodesById.get(attachmentParent.parentId)!;
  }

  const node = createNode(input, attachmentParent);

  let inserted = insert(graph, index, node, attachmentParent);

  if (next && next.outlineLevel > targetLevel) {
    inserted = produce(inserted, (draft) => {
      draft.messages[index.positionById.get(attachmentParent.id)!].activeBranchRootId = undefined;
      draft.messages.at(-1)!.activeBranchRootId = next.id;
      draft.messages[index.positionById.get(next.id)!].parentId = node.id;
      draft.activeCursorId = node.id;
    });
  }

  return inserted;
}

function getSameLevelChain(index: Index, node: Node) {
  let root = node;
  while (root.parentId) {
    const parent = index.nodesById.get(root.parentId)!;
    if (parent.outlineLevel !== root.outlineLevel) break;
    root = parent;
  }
  const chain: Node[] = [];
  let current: Node | undefined = root;
  while (current) {
    chain.push(current);
    current = index.sameLevelChildByParentId.get(current.id);
  }
  return chain;
}

function swap(
  graph: State,
  index: Index,
  chain: Node[],
  firstIndex: number,
  secondIndex: number,
): State {
  const oldRoot = chain[0];
  const reordered = chain.slice();
  [reordered[firstIndex], reordered[secondIndex]] = [reordered[secondIndex], reordered[firstIndex]];

  return produce(graph, (draft) => {
    reordered.forEach((node, position) => {
      draft.messages[index.positionById.get(node.id)!].parentId =
        position === 0 ? oldRoot.parentId : reordered[position - 1].id;
    });

    if (graph.rootNodeId === oldRoot.id) {
      draft.rootNodeId = reordered[0].id;
    }

    if (oldRoot.parentId) {
      const owner = index.nodesById.get(oldRoot.parentId)!;
      if (owner.activeBranchRootId === oldRoot.id) {
        draft.messages[index.positionById.get(owner.id)!].activeBranchRootId = reordered[0].id;
      }
    }
  });
}

function removeBranch(index: Index, branchId: string, removed: Set<string>) {
  const visit = (nodeId: string) => {
    removed.add(nodeId);
    for (const child of index.childrenByParentId.get(nodeId) ?? []) {
      visit(child.id);
    }
  };
  visit(branchId);
}

function remove(graph: State, index: Index, node: Node): State {
  const parent = node.parentId ? index.nodesById.get(node.parentId) : undefined;
  const sameLevelSuccessor = index.sameLevelChildByParentId.get(node.id);
  const removed = new Set([node.id]);

  for (const child of index.childrenByParentId.get(node.id) ?? []) {
    if (child.outlineLevel > node.outlineLevel) {
      removeBranch(index, child.id, removed);
    }
  }
  return produce(graph, (draft) => {
    if (sameLevelSuccessor) {
      draft.messages[index.positionById.get(sameLevelSuccessor.id)!].parentId = node.parentId;
    }

    if (parent?.activeBranchRootId === node.id) {
      draft.messages[index.positionById.get(parent.id)!].activeBranchRootId =
        sameLevelSuccessor?.id;
    }

    if (graph.rootNodeId === node.id) {
      draft.rootNodeId = sameLevelSuccessor?.id;
    }

    if (graph.activeCursorId && removed.has(graph.activeCursorId)) {
      draft.activeCursorId = parent?.id ?? sameLevelSuccessor?.id;
    }
    draft.messages = draft.messages.filter((candidate) => !removed.has(candidate.id));
  });
}

function clone(graph: State, createId: () => string) {
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

    for (const [kind, summary] of Object.entries(node.nodeSummaries ?? {})) {
      if (!summary) continue;
      const sourceNodeIds = summary.sourceNodeIds.map(remapId);
      if (sourceNodeIds.some((id) => !id)) {
        delete node.nodeSummaries![kind as keyof typeof node.nodeSummaries];
        continue;
      }
      summary.sourceNodeIds = sourceNodeIds as string[];
    }
  }

  cloned.rootNodeId = remapId(cloned.rootNodeId);
  cloned.activeCursorId = remapId(cloned.activeCursorId);

  const nodesById = new Map(cloned.messages.map((node) => [node.id, node]));
  for (const node of cloned.messages) {
    for (const summary of Object.values(node.nodeSummaries ?? {})) {
      if (!summary) continue;
      const sources = summary.sourceNodeIds.map((id) => nodesById.get(id)!);

      summary.sourceDigest = createCoverageDigest(sources);
    }
  }

  return { graph: cloned, ids };
}

function bindGraph<TResult>(workspace: Workspace, commit: (state: State) => TResult): Api<TResult> {
  const state = workspace.state;
  const getIndex = () => workspace.index;
  const getValidatedIndex = () => workspace.validatedIndex;

  const bindNode = (value: Node, index: Index): NodeApi<TResult> => {
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

      shiftLevel: (outlineDelta) => {
        const index = getValidatedIndex();
        if (outlineDelta === 0) return commit(state);
        if (!value.parentId) {
          throw new Error("The root node cannot change outline level");
        }
        const parent = index.nodesById.get(value.parentId)!;
        const targetLevel = value.outlineLevel + outlineDelta;
        if (targetLevel !== parent.outlineLevel && targetLevel !== parent.outlineLevel + 1) {
          throw new Error("Invalid outline level change");
        }
        return commit(shiftLevel(state, index, value, parent, outlineDelta));
      },

      setBranch: (branch) => {
        const index = getValidatedIndex();
        if (branch === undefined) {
          return commit(setBranch(state, index, value));
        }

        let resolved: Node | undefined;
        if (typeof branch === "string") {
          resolved = index.nodesById.get(branch);
        } else {
          resolved = index.nodesById.get(branch.id);
        }

        if (!resolved) {
          if (typeof branch === "string") {
            throw new Error(`Missing conversation node ${branch}`);
          } else {
            resolved = createNode(branch, value, value.outlineLevel + 1);
            return commit(createBranch(state, index, value, resolved));
          }
        }

        if (resolved.parentId !== value.id || resolved.outlineLevel !== value.outlineLevel + 1) {
          throw new Error(`Node ${resolved.id} is not a branch of ${value.id}`);
        }

        return commit(setBranch(state, index, value, resolved));
      },

      remove: () => commit(remove(state, getValidatedIndex(), value)),
    };
  };

  const findNode = (nodeId: string): NodeApi<TResult> | undefined => {
    const index = getIndex();
    const value = index.nodesById.get(nodeId);
    return value ? bindNode(value, index) : undefined;
  };

  return {
    state,
    validate() {
      getValidatedIndex();
    },
    projectActive: () => workspace.projectActive(),
    projectToCursor: () => workspace.projectToCursor(),
    projectTo: (nodeId) => {
      return workspace.projectTo(nodeId);
    },

    moveCursor: (nodeId) => {
      if (!workspace.projectActive().some((node) => node.id === nodeId)) {
        throw new Error("Conversation cursor must stay in the active projection");
      }
      return commit({ ...state, activeCursorId: nodeId });
    },

    node: (nodeId) => {
      const node = findNode(nodeId);
      if (!node) throw new Error(`Missing conversation node ${nodeId}`);
      return node;
    },

    findNode,

    insert: (input) => {
      const index = getValidatedIndex();
      if (index.nodesById.has(input.id)) {
        throw new Error(`Duplicate conversation node id: ${input.id}`);
      }

      const anchor = state.activeCursorId ? index.nodesById.get(state.activeCursorId)! : undefined;
      const node = createNode(input, anchor);

      return commit(insert(state, index, node, anchor));
    },

    insertProjected: (input, previousId) => {
      const index = getValidatedIndex();
      if (index.nodesById.has(input.id)) {
        throw new Error(`Duplicate conversation node id: ${input.id}`);
      }

      const projection = workspace.projectActive();
      if (!previousId) {
        return commit(insertProjected(state, index, input));
      }

      const previousIndex = projection.findIndex((node) => node.id === previousId);
      if (previousIndex < 0) {
        throw new Error("Inserted nodes must follow an active projected node");
      }
      return commit(insertProjected(state, index, input, projection[previousIndex]));
    },

    swap: (firstId, secondId) => {
      const index = getValidatedIndex();
      const first = index.nodesById.get(firstId);
      const second = index.nodesById.get(secondId);
      if (!first || !second) throw new Error("Cannot swap missing nodes");

      if (first.outlineLevel !== second.outlineLevel) {
        throw new Error("Only nodes at the same outline level can be swapped");
      }

      const chain = getSameLevelChain(index, first);
      const firstIndex = chain.findIndex((node) => node.id === first.id);
      const secondIndex = chain.findIndex((node) => node.id === second.id);
      if (secondIndex < 0) {
        throw new Error("Only nodes in the same outline chain can be swapped");
      }

      return commit(swap(state, index, chain, firstIndex, secondIndex));
    },

    clone: (...args) => {
      const { graph: cloned, ids } = clone(state, ...args);
      return { conversation: commit(cloned), ids };
    },
  };
}

export const Graph = Object.assign(bindGraph, {
  createMemory,
});
