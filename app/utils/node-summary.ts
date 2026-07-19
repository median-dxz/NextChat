import {
  createNodeSummarySourceDigest,
  type ConversationNode,
  type NodeSummary,
  type NodeSummaryKind,
} from "./conversation-graph";
import { estimateRequestMessageTokens } from "./context-compression";
import { estimateTokenLength } from "./token";

export interface OutlineChain {
  outlineLevel: number;
  nodes: ConversationNode[];
}

export type NodeSummaryFreshness = "fresh" | "stale";

export interface NodeSummaryEvaluation {
  structurallyEligible: boolean;
  freshness?: NodeSummaryFreshness;
  sourceNodes: ConversationNode[];
}

export interface NodeSummaryRuntimeCacheStats {
  nodeTokenHits: number;
  nodeTokenMisses: number;
  summaryTokenHits: number;
  summaryTokenMisses: number;
  digestHits: number;
  digestMisses: number;
}

export interface NodeSummaryRuntimeCache {
  stats: NodeSummaryRuntimeCacheStats;
  getNodeTokens(node: ConversationNode): number;
  getSummaryTokens(content: string): number;
  getSourceDigest(nodes: ConversationNode[]): string;
  clear(): void;
}

export interface SegmentGenerationBackground {
  kind: "raw" | "segment";
  endpointNodeId: string;
  tokens: number;
  snapshot: string;
  node?: ConversationNode;
  content?: string;
}

export interface SegmentMaintenancePlan {
  action: "create" | "refresh";
  chainRootId: string;
  ownerNodeId: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  sourceNodes: ConversationNode[];
  background: SegmentGenerationBackground[];
  expectedSummary?: NodeSummary;
}

export interface PlanSegmentMaintenanceArgs {
  projection: ConversationNode[];
  targetId: string;
  sourceTokenTarget: number;
  maxSourceNodes: number;
  inputBudget: number;
  force?: boolean;
  cache?: NodeSummaryRuntimeCache;
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

function summaryDigestValue(node: ConversationNode) {
  return [node.id, node.role, node.content];
}

export { createNodeSummarySourceDigest };

export function evaluateNodeSummary(
  owner: ConversationNode,
  kind: NodeSummaryKind,
  summary: NodeSummary,
  chains: OutlineChain[],
  createDigest: (
    nodes: ConversationNode[],
  ) => string = createNodeSummarySourceDigest,
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

export function createNodeSummaryRuntimeCache(): NodeSummaryRuntimeCache {
  const nodeTokens = new Map<string, number>();
  const summaryTokens = new Map<string, number>();
  const digests = new Map<string, string>();
  const stats: NodeSummaryRuntimeCacheStats = {
    nodeTokenHits: 0,
    nodeTokenMisses: 0,
    summaryTokenHits: 0,
    summaryTokenMisses: 0,
    digestHits: 0,
    digestMisses: 0,
  };

  return {
    stats,
    getNodeTokens(node) {
      const key = JSON.stringify(node.content);
      const cached = nodeTokens.get(key);
      if (cached !== undefined) {
        stats.nodeTokenHits += 1;
        return cached;
      }
      stats.nodeTokenMisses += 1;
      const tokens = estimateRequestMessageTokens(node);
      nodeTokens.set(key, tokens);
      return tokens;
    },
    getSummaryTokens(content) {
      const cached = summaryTokens.get(content);
      if (cached !== undefined) {
        stats.summaryTokenHits += 1;
        return cached;
      }
      stats.summaryTokenMisses += 1;
      const tokens = estimateTokenLength(content);
      summaryTokens.set(content, tokens);
      return tokens;
    },
    getSourceDigest(nodes) {
      const key = JSON.stringify(nodes.map(summaryDigestValue));
      const cached = digests.get(key);
      if (cached !== undefined) {
        stats.digestHits += 1;
        return cached;
      }
      stats.digestMisses += 1;
      const digest = createNodeSummarySourceDigest(nodes);
      digests.set(key, digest);
      return digest;
    },
    clear() {
      nodeTokens.clear();
      summaryTokens.clear();
      digests.clear();
      Object.keys(stats).forEach((key) => {
        stats[key as keyof NodeSummaryRuntimeCacheStats] = 0;
      });
    },
  };
}

interface SegmentInterval {
  start: number;
  end: number;
  owner: ConversationNode;
  summary: NodeSummary;
  evaluation: NodeSummaryEvaluation;
}

function collectSegmentIntervals(chain: OutlineChain, chains: OutlineChain[]) {
  const positions = new Map(chain.nodes.map((node, index) => [node.id, index]));
  return chain.nodes.flatMap((owner): SegmentInterval[] => {
    const summary = owner.nodeSummaries?.segment;
    if (!summary) return [];
    const evaluation = evaluateNodeSummary(owner, "segment", summary, chains);
    if (!evaluation.structurallyEligible) return [];
    return [
      {
        start: positions.get(evaluation.sourceNodes[0].id)!,
        end: positions.get(evaluation.sourceNodes.at(-1)!.id)!,
        owner,
        summary,
        evaluation,
      },
    ];
  });
}

function buildSegmentBackground(
  projection: ConversationNode[],
  chains: OutlineChain[],
  targetChain: OutlineChain,
  sourceStartIndex: number,
  availableTokens: number,
  cache: NodeSummaryRuntimeCache,
): SegmentGenerationBackground[] {
  if (availableTokens <= 0) return [];
  const projectionOrder = new Map(
    projection.map((node, index) => [node.id, index]),
  );
  const sourceStart = targetChain.nodes[sourceStartIndex];
  const sourceProjectionIndex = projectionOrder.get(sourceStart.id)!;
  const candidates: SegmentGenerationBackground[] = [];

  for (const owner of targetChain.nodes.slice(0, sourceStartIndex)) {
    const summary = owner.nodeSummaries?.segment;
    if (!summary) continue;
    const evaluation = evaluateNodeSummary(owner, "segment", summary, chains);
    if (!evaluation.structurallyEligible || evaluation.freshness !== "fresh") {
      continue;
    }
    candidates.push({
      kind: "segment",
      endpointNodeId: owner.id,
      content: summary.content,
      tokens: cache.getSummaryTokens(summary.content),
      snapshot: JSON.stringify([
        summary.content,
        summary.sourceNodeIds,
        summary.sourceDigest,
        summary.provenance,
      ]),
    });
  }

  for (const node of projection.slice(0, sourceProjectionIndex)) {
    if (node.outlineLevel >= targetChain.outlineLevel) continue;
    candidates.push({
      kind: "raw",
      endpointNodeId: node.id,
      node,
      tokens: cache.getNodeTokens(node),
      snapshot: cache.getSourceDigest([node]),
    });
  }

  candidates.sort(
    (left, right) =>
      projectionOrder.get(left.endpointNodeId)! -
      projectionOrder.get(right.endpointNodeId)!,
  );
  const selected: SegmentGenerationBackground[] = [];
  let tokens = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (tokens + candidate.tokens > availableTokens) continue;
    selected.unshift(candidate);
    tokens += candidate.tokens;
  }
  return selected;
}

function createSegmentPlan(
  action: SegmentMaintenancePlan["action"],
  projection: ConversationNode[],
  chains: OutlineChain[],
  targetChain: OutlineChain,
  sourceNodes: ConversationNode[],
  owner: ConversationNode,
  inputBudget: number,
  cache: NodeSummaryRuntimeCache,
  expectedSummary?: NodeSummary,
): SegmentMaintenancePlan | undefined {
  const sourceTokens = sourceNodes.reduce(
    (tokens, node) => tokens + cache.getNodeTokens(node),
    0,
  );
  if (sourceTokens > inputBudget) return;
  const sourceStartIndex = targetChain.nodes.findIndex(
    (node) => node.id === sourceNodes[0].id,
  );
  return {
    action,
    chainRootId: targetChain.nodes[0].id,
    ownerNodeId: owner.id,
    sourceNodeIds: sourceNodes.map((node) => node.id),
    sourceDigest: cache.getSourceDigest(sourceNodes),
    sourceNodes,
    background: buildSegmentBackground(
      projection,
      chains,
      targetChain,
      sourceStartIndex,
      inputBudget - sourceTokens,
      cache,
    ),
    expectedSummary: expectedSummary
      ? {
          ...expectedSummary,
          sourceNodeIds: expectedSummary.sourceNodeIds.slice(),
        }
      : undefined,
  };
}

export function planSegmentMaintenance(
  args: PlanSegmentMaintenanceArgs,
): SegmentMaintenancePlan | undefined {
  const target = args.projection.find((node) => node.id === args.targetId);
  if (!target || target.role !== "assistant") return;
  const chains = partitionProjectionIntoOutlineChains(args.projection);
  const targetChain = chains.find((chain) =>
    chain.nodes.some((node) => node.id === target.id),
  );
  if (!targetChain) return;
  const targetIndex = targetChain.nodes.findIndex(
    (node) => node.id === target.id,
  );
  const cache = args.cache ?? createNodeSummaryRuntimeCache();
  const intervals = collectSegmentIntervals(targetChain, chains)
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (args.force && target.nodeSummaries?.segment) {
    const current = target.nodeSummaries.segment;
    const evaluation = evaluateNodeSummary(target, "segment", current, chains);
    const sourceNodes = evaluation.structurallyEligible
      ? evaluation.sourceNodes
      : [target];
    return createSegmentPlan(
      "refresh",
      args.projection,
      chains,
      targetChain,
      sourceNodes,
      target,
      args.inputBudget,
      cache,
      current,
    );
  }

  const staleGenerated = intervals.find(
    (interval) =>
      interval.summary.provenance === "generated" &&
      interval.evaluation.freshness === "stale",
  );
  if (staleGenerated) {
    return createSegmentPlan(
      "refresh",
      args.projection,
      chains,
      targetChain,
      staleGenerated.evaluation.sourceNodes,
      staleGenerated.owner,
      args.inputBudget,
      cache,
      staleGenerated.summary,
    );
  }

  let nextSourceIndex = 0;
  for (const interval of intervals) {
    if (interval.start !== nextSourceIndex) return;
    nextSourceIndex = interval.end + 1;
  }
  if (nextSourceIndex > targetIndex || target.nodeSummaries?.segment) return;

  const sourceNodes = targetChain.nodes.slice(nextSourceIndex, targetIndex + 1);
  const sourceTokens = sourceNodes.reduce(
    (tokens, node) => tokens + cache.getNodeTokens(node),
    0,
  );
  const thresholdReached =
    sourceTokens >= Math.max(0, args.sourceTokenTarget) ||
    sourceNodes.length >= Math.max(1, args.maxSourceNodes);
  if (!args.force && !thresholdReached) return;

  return createSegmentPlan(
    "create",
    args.projection,
    chains,
    targetChain,
    sourceNodes,
    target,
    args.inputBudget,
    cache,
  );
}
