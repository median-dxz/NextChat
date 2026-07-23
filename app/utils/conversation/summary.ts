import {
  type ConversationGraphApi,
  type ConversationGraphState,
} from "./graph";
import {
  createSourceDigest,
  type ConversationNode,
  type NodeSummary,
  type NodeSummaryKind,
} from "./node";

export type NodeSummaryFreshness = "fresh" | "stale";

export interface OutlineChain {
  outlineLevel: number;
  nodes: ConversationNode[];
}

export interface NodeSummaryEvaluation {
  structurallyEligible: boolean;
  freshness?: NodeSummaryFreshness;
  sourceNodes: ConversationNode[];
}

export interface SegmentGenerationBackground {
  kind: "raw" | "segment";
  endpointNodeId: string;
  tokens: number;
  snapshot: string;
  node?: ConversationNode;
  content?: string;
}

export interface CheckpointGenerationInput {
  kind: "segment" | "checkpoint";
  ownerNodeId: string;
  content: string;
  tokens: number;
  snapshot: string;
}

interface SummaryMaintenancePlanBase {
  action: "create" | "refresh";
  chainRootId: string;
  ownerNodeId: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  sourceNodes: ConversationNode[];
  expectedSummary?: NodeSummary;
}

export interface SegmentMaintenancePlan extends SummaryMaintenancePlanBase {
  kind: "segment";
  background: SegmentGenerationBackground[];
}

export interface CheckpointMaintenancePlan extends SummaryMaintenancePlanBase {
  kind: "checkpoint";
  inputs: CheckpointGenerationInput[];
}

export type SummaryMaintenancePlan =
  SegmentMaintenancePlan | CheckpointMaintenancePlan;

export interface ConversationNodeSummaryApi<TResult> {
  edit(kind: NodeSummaryKind, content: string): TResult;
  remove(kind: NodeSummaryKind): TResult;
}

export function partitionProjectionIntoOutlineChains(
  projection: ConversationNode[],
): OutlineChain[] {
  const nodeChainIndexes = new Map<string, number>();
  const nodesById = new Map<string, ConversationNode>();
  const chains: OutlineChain[] = [];

  for (const node of projection) {
    const parent = node.parentId ? nodesById.get(node.parentId) : undefined;
    const parentChainIndex = parent
      ? nodeChainIndexes.get(parent.id)
      : undefined;
    let chainIndex: number;
    if (
      parent &&
      parent.outlineLevel === node.outlineLevel &&
      parentChainIndex !== undefined
    ) {
      chainIndex = parentChainIndex;
    } else {
      chainIndex = chains.length;
      chains.push({ outlineLevel: node.outlineLevel, nodes: [] });
    }
    chains[chainIndex].nodes.push(node);
    nodeChainIndexes.set(node.id, chainIndex);
    nodesById.set(node.id, node);
  }

  return chains;
}

export function evaluateNodeSummary(
  owner: ConversationNode,
  kind: NodeSummaryKind,
  summary: NodeSummary,
  chains: OutlineChain[],
  createDigest: (nodes: ConversationNode[]) => string = createSourceDigest,
): NodeSummaryEvaluation {
  if (owner.role !== "assistant" || summary.sourceNodeIds.length === 0) {
    return { structurallyEligible: false, sourceNodes: [] };
  }

  const locations = new Map<
    string,
    { chainIndex: number; nodeIndex: number; node: ConversationNode }
  >();
  chains.forEach((chain, chainIndex) =>
    chain.nodes.forEach((node, nodeIndex) =>
      locations.set(node.id, { chainIndex, nodeIndex, node }),
    ),
  );
  const sourceLocations = summary.sourceNodeIds.map((id) => locations.get(id));
  if (sourceLocations.some((location) => !location)) {
    return { structurallyEligible: false, sourceNodes: [] };
  }
  const resolved = sourceLocations.filter(
    (location): location is NonNullable<typeof location> => Boolean(location),
  );
  const first = resolved[0];
  const sameContinuousChain = resolved.every(
    (location, index) =>
      location.chainIndex === first.chainIndex &&
      location.nodeIndex === first.nodeIndex + index,
  );
  const ownerIsLastSource =
    resolved.at(-1)?.node.id === owner.id &&
    resolved.at(-1)?.node.role === "assistant";
  const checkpointStartsAtChainRoot =
    kind !== "checkpoint" || first.nodeIndex === 0;
  if (
    !sameContinuousChain ||
    !ownerIsLastSource ||
    !checkpointStartsAtChainRoot
  ) {
    return { structurallyEligible: false, sourceNodes: [] };
  }

  const sourceNodes = resolved.map((location) => location.node);
  return {
    structurallyEligible: true,
    freshness:
      summary.sourceDigest === createDigest(sourceNodes) ? "fresh" : "stale",
    sourceNodes,
  };
}

function isSameNodeSummary(left: NodeSummary | undefined, right: NodeSummary) {
  return (
    left?.content === right.content &&
    left.sourceDigest === right.sourceDigest &&
    left.provenance === right.provenance &&
    left.sourceNodeIds.length === right.sourceNodeIds.length &&
    left.sourceNodeIds.every((id, index) => id === right.sourceNodeIds[index])
  );
}

export function createSummarySnapshot(summary: NodeSummary) {
  return JSON.stringify([
    summary.content,
    summary.sourceNodeIds,
    summary.sourceDigest,
    summary.provenance,
  ]);
}

function isGenerationInputCurrent(
  nodesById: Map<string, ConversationNode>,
  chains: OutlineChain[],
  input: SegmentGenerationBackground | CheckpointGenerationInput,
) {
  const nodeId =
    "endpointNodeId" in input ? input.endpointNodeId : input.ownerNodeId;
  const node = nodesById.get(nodeId);
  if (!node) return false;
  if (input.kind === "raw") {
    return createSourceDigest([node]) === input.snapshot;
  }
  const summary = node.nodeSummaries?.[input.kind];
  return Boolean(
    summary &&
    createSummarySnapshot(summary) === input.snapshot &&
    evaluateNodeSummary(node, input.kind, summary, chains).freshness ===
      "fresh",
  );
}

function updateNode(
  state: ConversationGraphState,
  nodeId: string,
  update: (node: ConversationNode) => void,
) {
  let found = false;
  const messages = state.messages.map((node) => {
    if (node.id !== nodeId) return node;
    found = true;
    const next = structuredClone(node);
    update(next);
    return next;
  });
  if (!found) throw new Error(`Missing conversation node ${nodeId}`);
  return { ...state, messages };
}

function bindConversationSummary<TResult>(
  graph: ConversationGraphApi<TResult>,
  commitData: (state: ConversationGraphState) => TResult,
) {
  const state = graph.state;
  const findNode = (
    nodeId: string,
  ): ConversationNodeSummaryApi<TResult> | undefined => {
    const graphNode = graph.findNode(nodeId);
    if (!graphNode) return;
    const node = graphNode.value;
    const commitNode = (updater: (target: ConversationNode) => void) =>
      commitData(updateNode(state, node.id, updater));
    const projection = graph.projectTo(node.id);
    const chains = partitionProjectionIntoOutlineChains(projection);

    return {
      edit(kind, content) {
        const value = content.trim();
        if (!value) return this.remove(kind);
        if (node.role !== "assistant") {
          throw new Error("Only assistant nodes can own summaries");
        }
        const chain = chains.find((candidate) =>
          candidate.nodes.some((candidateNode) => candidateNode.id === node.id),
        );
        const ownerIndex =
          chain?.nodes.findIndex((candidate) => candidate.id === node.id) ?? -1;
        if (!chain || ownerIndex < 0) {
          throw new Error(`Missing outline chain for ${node.id}`);
        }
        const sourceNodeIds =
          node.nodeSummaries?.[kind]?.sourceNodeIds ??
          (kind === "checkpoint"
            ? chain.nodes.slice(0, ownerIndex + 1).map((source) => source.id)
            : [node.id]);
        const sourcesById = new Map(
          projection.map((source) => [source.id, source]),
        );
        const sourceNodes = sourceNodeIds
          .map((id) => sourcesById.get(id))
          .filter((source): source is ConversationNode => Boolean(source));
        const candidate: NodeSummary = {
          content,
          sourceNodeIds,
          sourceDigest: createSourceDigest(sourceNodes),
          provenance: "user-edited",
        };
        if (
          !evaluateNodeSummary(node, kind, candidate, chains)
            .structurallyEligible
        ) {
          throw new Error(`Invalid ${kind} summary coverage for ${node.id}`);
        }
        return commitNode((target) => {
          target.nodeSummaries ??= {};
          target.nodeSummaries[kind] = candidate;
        });
      },
      remove(kind) {
        return commitNode((target) => {
          if (!target.nodeSummaries) return;
          delete target.nodeSummaries[kind];
          if (Object.keys(target.nodeSummaries).length === 0) {
            delete target.nodeSummaries;
          }
        });
      },
    };
  };

  return {
    node(nodeId: string) {
      const node = findNode(nodeId);
      if (!node) throw new Error(`Missing conversation node ${nodeId}`);
      return node;
    },
    findNode,
    commitGenerated(plan: SummaryMaintenancePlan, content: string) {
      const currentProjection = graph.projectTo(plan.ownerNodeId);
      const target = currentProjection.find(
        (node) => node.id === plan.ownerNodeId,
      );
      if (!target || target.role !== "assistant") return;
      const sourcesById = new Map(
        currentProjection.map((node) => [node.id, node]),
      );
      const sourceNodes = plan.sourceNodeIds
        .map((id) => sourcesById.get(id))
        .filter((node): node is ConversationNode => Boolean(node));
      if (sourceNodes.length !== plan.sourceNodeIds.length) return;
      const sourceDigest = createSourceDigest(sourceNodes);
      if (sourceDigest !== plan.sourceDigest) return;
      const currentSummary = target.nodeSummaries?.[plan.kind];
      if (
        plan.expectedSummary
          ? !isSameNodeSummary(currentSummary, plan.expectedSummary)
          : Boolean(currentSummary)
      ) {
        return;
      }

      const chains = partitionProjectionIntoOutlineChains(currentProjection);
      const inputs: Array<
        SegmentGenerationBackground | CheckpointGenerationInput
      > = plan.kind === "segment" ? plan.background : plan.inputs;
      if (
        !inputs.every((input) =>
          isGenerationInputCurrent(sourcesById, chains, input),
        )
      ) {
        return;
      }

      const candidate: NodeSummary = {
        content,
        sourceNodeIds: plan.sourceNodeIds,
        sourceDigest,
        provenance: "generated",
      };
      if (
        !evaluateNodeSummary(target, plan.kind, candidate, chains)
          .structurallyEligible
      ) {
        return;
      }
      return commitData(
        updateNode(state, target.id, (current) => {
          current.nodeSummaries ??= {};
          current.nodeSummaries[plan.kind] = candidate;
        }),
      );
    },
  };
}

export type ConversationSummaryApi<TResult> = ReturnType<
  typeof bindConversationSummary<TResult>
>;
export const ConversationSummary = bindConversationSummary;
