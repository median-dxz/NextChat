import type { ConversationNode } from "./conversation-node";
import type { RequestMessage } from "../client/api";
import { estimateRequestMessageTokens } from "./context-budget";
import { hash } from "./hmac";
import { estimateTokenLength } from "./token";

export type NodeSummaryKind = "segment" | "checkpoint";
export type NodeSummaryProvenance = "generated" | "user-edited";

export interface NodeSummary {
  content: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  provenance: NodeSummaryProvenance;
}

export function createSourceDigest(nodes: ConversationNode[]) {
  const summaryDigestValue = (node: ConversationNode) => [
    node.id,
    node.role,
    node.content,
  ];
  return hash(JSON.stringify(nodes.map(summaryDigestValue)));
}

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

export interface CheckpointGenerationInput {
  kind: "segment" | "checkpoint";
  ownerNodeId: string;
  content: string;
  tokens: number;
  snapshot: string;
}

export interface CheckpointMaintenancePlan {
  action: "create" | "refresh";
  chainRootId: string;
  ownerNodeId: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  sourceNodes: ConversationNode[];
  inputs: CheckpointGenerationInput[];
  expectedSummary?: NodeSummary;
}

export interface PlanCheckpointMaintenanceArgs {
  projection: ConversationNode[];
  targetId: string;
  targetSegments: number;
  mergeTokenTarget: number;
  inputBudget: number;
  force?: boolean;
  cache?: NodeSummaryRuntimeCache;
}

export type ContextRepresentation =
  | { kind: "raw"; nodeId: string }
  | {
      kind: "segment" | "checkpoint";
      ownerNodeId: string;
      sourceNodeIds: string[];
      content: string;
      freshness: NodeSummaryFreshness;
    };

export interface ChainContextState {
  tokens: number;
  coveredNodeCount: number;
  freshCoveredNodeCount: number;
  rawCoveredNodeCount: number;
  segmentCoveredNodeCount: number;
  checkpointCoveredNodeCount: number;
  selectedRepresentations: ContextRepresentation[];
}

export interface OutlineChainContextFrontier {
  chainRootId: string;
  outlineLevel: number;
  nodeIds: string[];
  states: ChainContextState[];
  approximated: boolean;
}

export interface RecentRawContext {
  tokens: number;
  nodeIds: string[];
  representations: ContextRepresentation[];
}

export interface ChainContextPlanningResult {
  recentRaw: RecentRawContext;
  optionalBudget: number;
  optionalNodeIds: string[];
  chains: OutlineChainContextFrontier[];
}

export interface PlanChainContextArgs {
  projection: ConversationNode[];
  recentRawNodeCount: number;
  availableTokens: number;
  cache?: NodeSummaryRuntimeCache;
  frontierLimit?: number;
  tokenBucketSize?: number;
}

export interface ContextParetoOptions {
  frontierLimit?: number;
  tokenBucketSize?: number;
}

export interface ContextPlanningDiagnostics {
  approximated: boolean;
  maxCandidateCount: number;
  finalFrontierSize: number;
  chainCount: number;
}

export interface CombinedContextFrontier {
  states: ChainContextState[];
  diagnostics: ContextPlanningDiagnostics;
}

export interface NodeConversationContextPlan {
  tokens: number;
  representations: ContextRepresentation[];
  recentRaw: RecentRawContext;
  state: ChainContextState;
  diagnostics: ContextPlanningDiagnostics;
}

export interface PlanNodeConversationContextArgs extends PlanChainContextArgs {}

export function materializeContextRepresentations(
  projection: ConversationNode[],
  representations: ContextRepresentation[],
): RequestMessage[] {
  const nodesById = new Map(projection.map((node) => [node.id, node]));
  const projectionOrder = new Map(
    projection.map((node, index) => [node.id, index]),
  );
  return representations
    .map((representation) => {
      const endpointId =
        representation.kind === "raw"
          ? representation.nodeId
          : representation.sourceNodeIds.at(-1);
      const order = endpointId ? projectionOrder.get(endpointId) : undefined;
      if (order === undefined) return;
      if (representation.kind === "raw") {
        const node = nodesById.get(representation.nodeId);
        if (!node) return;
        return {
          order,
          message: {
            role: node.role,
            content: node.content,
          } satisfies RequestMessage,
        };
      }
      return {
        order,
        message: {
          role: "assistant" as const,
          content: representation.content,
        } satisfies RequestMessage,
      };
    })
    .filter(
      (
        item,
      ): item is {
        order: number;
        message: RequestMessage;
      } => Boolean(item),
    )
    .sort((left, right) => left.order - right.order)
    .map((item) => item.message);
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
      const key = JSON.stringify([node.id, node.role, node.content]);
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
      const digest = createSourceDigest(nodes);
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

interface CheckpointCandidate {
  end: number;
  owner: ConversationNode;
  summary: NodeSummary;
  evaluation: NodeSummaryEvaluation;
}

function summaryInputSnapshot(summary: NodeSummary) {
  return JSON.stringify([
    summary.content,
    summary.sourceNodeIds,
    summary.sourceDigest,
    summary.provenance,
  ]);
}

function collectCheckpointCandidates(
  chain: OutlineChain,
  chains: OutlineChain[],
) {
  const positions = new Map(chain.nodes.map((node, index) => [node.id, index]));
  return chain.nodes.flatMap((owner): CheckpointCandidate[] => {
    const summary = owner.nodeSummaries?.checkpoint;
    if (!summary) return [];
    const evaluation = evaluateNodeSummary(
      owner,
      "checkpoint",
      summary,
      chains,
    );
    if (!evaluation.structurallyEligible) return [];
    return [
      {
        end: positions.get(owner.id)!,
        owner,
        summary,
        evaluation,
      },
    ];
  });
}

function collectFreshSegmentsForRange(
  intervals: SegmentInterval[],
  start: number,
  end: number,
) {
  const selected: SegmentInterval[] = [];
  let cursor = start;
  for (const interval of intervals) {
    if (interval.end < start) continue;
    if (interval.start !== cursor || interval.end > end) return;
    if (interval.evaluation.freshness !== "fresh") return;
    selected.push(interval);
    cursor = interval.end + 1;
    if (cursor === end + 1) break;
  }
  return cursor === end + 1 ? selected : undefined;
}

function createCheckpointPlan(
  action: CheckpointMaintenancePlan["action"],
  targetChain: OutlineChain,
  ownerIndex: number,
  base: CheckpointCandidate | undefined,
  segments: SegmentInterval[],
  inputBudget: number,
  cache: NodeSummaryRuntimeCache,
  expectedSummary?: NodeSummary,
): CheckpointMaintenancePlan | undefined {
  const inputs: CheckpointGenerationInput[] = [];
  if (base) {
    inputs.push({
      kind: "checkpoint",
      ownerNodeId: base.owner.id,
      content: base.summary.content,
      tokens: cache.getSummaryTokens(base.summary.content),
      snapshot: summaryInputSnapshot(base.summary),
    });
  }
  for (const segment of segments) {
    inputs.push({
      kind: "segment",
      ownerNodeId: segment.owner.id,
      content: segment.summary.content,
      tokens: cache.getSummaryTokens(segment.summary.content),
      snapshot: summaryInputSnapshot(segment.summary),
    });
  }
  if (
    inputs.length === 0 ||
    inputs.reduce((tokens, input) => tokens + input.tokens, 0) > inputBudget
  ) {
    return;
  }
  const sourceNodes = targetChain.nodes.slice(0, ownerIndex + 1);
  return {
    action,
    chainRootId: targetChain.nodes[0].id,
    ownerNodeId: targetChain.nodes[ownerIndex].id,
    sourceNodeIds: sourceNodes.map((node) => node.id),
    sourceDigest: cache.getSourceDigest(sourceNodes),
    sourceNodes,
    inputs,
    expectedSummary: expectedSummary
      ? {
          ...expectedSummary,
          sourceNodeIds: expectedSummary.sourceNodeIds.slice(),
        }
      : undefined,
  };
}

export function planCheckpointMaintenance(
  args: PlanCheckpointMaintenanceArgs,
): CheckpointMaintenancePlan | undefined {
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
  const segments = collectSegmentIntervals(targetChain, chains)
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const checkpoints = collectCheckpointCandidates(targetChain, chains)
    .filter((checkpoint) => checkpoint.end <= targetIndex)
    .sort((left, right) => left.end - right.end);

  const forcedSummary = args.force
    ? target.nodeSummaries?.checkpoint
    : undefined;
  const staleGenerated = checkpoints.find(
    (checkpoint) =>
      checkpoint.summary.provenance === "generated" &&
      checkpoint.evaluation.freshness === "stale",
  );
  const forcedCheckpoint = forcedSummary
    ? {
        end: targetIndex,
        owner: target,
        summary: forcedSummary,
      }
    : undefined;
  const refresh = forcedCheckpoint ?? staleGenerated;
  if (refresh) {
    const base = checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.end < refresh.end &&
          checkpoint.evaluation.freshness === "fresh",
      )
      .at(-1);
    const rangeSegments = collectFreshSegmentsForRange(
      segments,
      (base?.end ?? -1) + 1,
      refresh.end,
    );
    if (!rangeSegments) return;
    return createCheckpointPlan(
      "refresh",
      targetChain,
      refresh.end,
      base,
      rangeSegments,
      args.inputBudget,
      cache,
      refresh.summary,
    );
  }

  const base = checkpoints
    .filter((checkpoint) => checkpoint.evaluation.freshness === "fresh")
    .at(-1);
  const start = (base?.end ?? -1) + 1;
  const availableSegments = segments.filter((segment) => segment.end >= start);
  if (availableSegments.length === 0) return;
  let cursor = start;
  const continuous: SegmentInterval[] = [];
  for (const segment of availableSegments) {
    if (segment.start !== cursor || segment.evaluation.freshness !== "fresh") {
      return;
    }
    continuous.push(segment);
    cursor = segment.end + 1;
  }
  const ownerIndex = continuous.at(-1)!.end;
  const owner = targetChain.nodes[ownerIndex];
  if (owner.nodeSummaries?.checkpoint) return;
  const inputTokens =
    (base ? cache.getSummaryTokens(base.summary.content) : 0) +
    continuous.reduce(
      (tokens, segment) =>
        tokens + cache.getSummaryTokens(segment.summary.content),
      0,
    );
  const thresholdReached =
    continuous.length >= Math.max(1, args.targetSegments) ||
    inputTokens >= Math.max(0, args.mergeTokenTarget);
  if (!args.force && !thresholdReached) return;
  return createCheckpointPlan(
    "create",
    targetChain,
    ownerIndex,
    base,
    continuous,
    args.inputBudget,
    cache,
  );
}

function emptyChainContextState(): ChainContextState {
  return {
    tokens: 0,
    coveredNodeCount: 0,
    freshCoveredNodeCount: 0,
    rawCoveredNodeCount: 0,
    segmentCoveredNodeCount: 0,
    checkpointCoveredNodeCount: 0,
    selectedRepresentations: [],
  };
}

export function compareChainContextStates(
  left: ChainContextState,
  right: ChainContextState,
) {
  const benefitKeys = [
    "coveredNodeCount",
    "freshCoveredNodeCount",
    "rawCoveredNodeCount",
    "segmentCoveredNodeCount",
    "checkpointCoveredNodeCount",
  ] as const;
  for (const key of benefitKeys) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return right.tokens - left.tokens;
}

function chainStateDominates(
  left: ChainContextState,
  right: ChainContextState,
) {
  return (
    left.tokens <= right.tokens && compareChainContextStates(left, right) > 0
  );
}

function chainStateSignature(state: ChainContextState) {
  return JSON.stringify([
    state.tokens,
    state.coveredNodeCount,
    state.freshCoveredNodeCount,
    state.rawCoveredNodeCount,
    state.segmentCoveredNodeCount,
    state.checkpointCoveredNodeCount,
  ]);
}

function pruneChainContextStates(states: ChainContextState[]) {
  const unique = new Map<string, ChainContextState>();
  for (const state of states) {
    const signature = chainStateSignature(state);
    if (!unique.has(signature)) unique.set(signature, state);
  }
  const candidates = [...unique.values()].sort(
    (left, right) =>
      left.tokens - right.tokens || compareChainContextStates(right, left),
  );
  const frontier: ChainContextState[] = [];
  let best: ChainContextState | undefined;
  for (const candidate of candidates) {
    if (best && chainStateDominates(best, candidate)) continue;
    frontier.push(candidate);
    if (!best || compareChainContextStates(candidate, best) > 0) {
      best = candidate;
    }
  }
  return frontier;
}

const DEFAULT_CONTEXT_FRONTIER_LIMIT = 512;
const DEFAULT_CONTEXT_TOKEN_BUCKET_SIZE = 128;

function combineContextStates(
  left: ChainContextState,
  right: ChainContextState,
): ChainContextState {
  return {
    tokens: left.tokens + right.tokens,
    coveredNodeCount: left.coveredNodeCount + right.coveredNodeCount,
    freshCoveredNodeCount:
      left.freshCoveredNodeCount + right.freshCoveredNodeCount,
    rawCoveredNodeCount: left.rawCoveredNodeCount + right.rawCoveredNodeCount,
    segmentCoveredNodeCount:
      left.segmentCoveredNodeCount + right.segmentCoveredNodeCount,
    checkpointCoveredNodeCount:
      left.checkpointCoveredNodeCount + right.checkpointCoveredNodeCount,
    selectedRepresentations: [
      ...left.selectedRepresentations,
      ...right.selectedRepresentations,
    ],
  };
}

function compareFidelityVector(
  left: ChainContextState,
  right: ChainContextState,
) {
  const keys = [
    "freshCoveredNodeCount",
    "rawCoveredNodeCount",
    "segmentCoveredNodeCount",
    "checkpointCoveredNodeCount",
  ] as const;
  for (const key of keys) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return right.tokens - left.tokens;
}

function bestState(
  states: ChainContextState[],
  compare: (left: ChainContextState, right: ChainContextState) => number,
) {
  return states.reduce((best, candidate) =>
    compare(candidate, best) > 0 ? candidate : best,
  );
}

function approximateContextStates(
  states: ChainContextState[],
  tokenBudget: number,
  frontierLimit: number,
  tokenBucketSize: number,
) {
  const limit = Math.max(3, Math.floor(frontierLimit));
  const exact = pruneChainContextStates(states);
  if (exact.length <= limit) return { states: exact, approximated: false };

  const extremes = [
    bestState(exact, (left, right) =>
      right.tokens !== left.tokens
        ? right.tokens - left.tokens
        : compareChainContextStates(left, right),
    ),
    bestState(exact, (left, right) =>
      left.coveredNodeCount !== right.coveredNodeCount
        ? left.coveredNodeCount - right.coveredNodeCount
        : compareChainContextStates(left, right),
    ),
    bestState(exact, compareFidelityVector),
  ];
  const extremeSignatures = new Set(extremes.map(chainStateSignature));
  const availableBucketSlots = Math.max(1, limit - extremeSignatures.size);
  const bucketWidth = Math.max(
    1,
    Math.floor(tokenBucketSize),
    Math.ceil((Math.max(0, tokenBudget) + 1) / availableBucketSlots),
  );
  const buckets = new Map<number, ChainContextState>();
  for (const candidate of exact) {
    const bucket = Math.floor(candidate.tokens / bucketWidth);
    const current = buckets.get(bucket);
    if (!current || compareChainContextStates(candidate, current) > 0) {
      buckets.set(bucket, candidate);
    }
  }
  const retained = new Map<string, ChainContextState>();
  for (const candidate of extremes) {
    retained.set(chainStateSignature(candidate), candidate);
  }
  for (const candidate of [...buckets.values()].sort((left, right) =>
    compareChainContextStates(right, left),
  )) {
    if (retained.size >= limit) break;
    retained.set(chainStateSignature(candidate), candidate);
  }
  return { states: [...retained.values()], approximated: true };
}

interface ChainContextEdge {
  end: number;
  tokens: number;
  coveredNodeCount: number;
  freshCoveredNodeCount: number;
  rawCoveredNodeCount: number;
  segmentCoveredNodeCount: number;
  checkpointCoveredNodeCount: number;
  representation: ContextRepresentation;
}

function extendChainContextState(
  state: ChainContextState,
  edge: ChainContextEdge,
): ChainContextState {
  return {
    tokens: state.tokens + edge.tokens,
    coveredNodeCount: state.coveredNodeCount + edge.coveredNodeCount,
    freshCoveredNodeCount:
      state.freshCoveredNodeCount + edge.freshCoveredNodeCount,
    rawCoveredNodeCount: state.rawCoveredNodeCount + edge.rawCoveredNodeCount,
    segmentCoveredNodeCount:
      state.segmentCoveredNodeCount + edge.segmentCoveredNodeCount,
    checkpointCoveredNodeCount:
      state.checkpointCoveredNodeCount + edge.checkpointCoveredNodeCount,
    selectedRepresentations: [
      ...state.selectedRepresentations,
      edge.representation,
    ],
  };
}

function buildChainContextEdges(
  chain: OutlineChain,
  allChains: OutlineChain[],
  nodeCount: number,
  cache: NodeSummaryRuntimeCache,
) {
  const positions = new Map(chain.nodes.map((node, index) => [node.id, index]));
  const edges = Array.from(
    { length: nodeCount },
    () => [] as ChainContextEdge[],
  );
  for (let index = 0; index < nodeCount; index += 1) {
    const node = chain.nodes[index];
    edges[index].push({
      end: index + 1,
      tokens: cache.getNodeTokens(node),
      coveredNodeCount: 1,
      freshCoveredNodeCount: 1,
      rawCoveredNodeCount: 1,
      segmentCoveredNodeCount: 0,
      checkpointCoveredNodeCount: 0,
      representation: { kind: "raw", nodeId: node.id },
    });
  }
  for (const owner of chain.nodes.slice(0, nodeCount)) {
    for (const kind of ["segment", "checkpoint"] as const) {
      const summary = owner.nodeSummaries?.[kind];
      if (!summary) continue;
      const evaluation = evaluateNodeSummary(owner, kind, summary, allChains);
      if (!evaluation.structurallyEligible || !evaluation.freshness) continue;
      const start = positions.get(evaluation.sourceNodes[0].id);
      const end = positions.get(evaluation.sourceNodes.at(-1)!.id);
      if (start === undefined || end === undefined || end >= nodeCount)
        continue;
      const coveredNodeCount = end - start + 1;
      edges[start].push({
        end: end + 1,
        tokens: cache.getSummaryTokens(summary.content),
        coveredNodeCount,
        freshCoveredNodeCount:
          evaluation.freshness === "fresh" ? coveredNodeCount : 0,
        rawCoveredNodeCount: 0,
        segmentCoveredNodeCount: kind === "segment" ? coveredNodeCount : 0,
        checkpointCoveredNodeCount:
          kind === "checkpoint" ? coveredNodeCount : 0,
        representation: {
          kind,
          ownerNodeId: owner.id,
          sourceNodeIds: summary.sourceNodeIds.slice(),
          content: summary.content,
          freshness: evaluation.freshness,
        },
      });
    }
  }
  return edges;
}

export function planOutlineChainContext(
  chain: OutlineChain,
  allChains: OutlineChain[],
  nodeCount: number,
  tokenBudget: number,
  cache: NodeSummaryRuntimeCache = createNodeSummaryRuntimeCache(),
  options: ContextParetoOptions = {},
): OutlineChainContextFrontier {
  const limitedNodeCount = Math.max(0, Math.min(nodeCount, chain.nodes.length));
  const budget = Math.max(0, tokenBudget);
  const edges = buildChainContextEdges(
    chain,
    allChains,
    limitedNodeCount,
    cache,
  );
  const statesAt = Array.from(
    { length: limitedNodeCount + 1 },
    () => [] as ChainContextState[],
  );
  for (let cutoff = 0; cutoff <= limitedNodeCount; cutoff += 1) {
    statesAt[cutoff].push(emptyChainContextState());
  }
  let approximated = false;
  for (let position = 0; position < limitedNodeCount; position += 1) {
    const pruned = approximateContextStates(
      statesAt[position],
      budget,
      options.frontierLimit ?? DEFAULT_CONTEXT_FRONTIER_LIMIT,
      options.tokenBucketSize ?? DEFAULT_CONTEXT_TOKEN_BUCKET_SIZE,
    );
    statesAt[position] = pruned.states;
    approximated ||= pruned.approximated;
    for (const state of statesAt[position]) {
      for (const edge of edges[position]) {
        const next = extendChainContextState(state, edge);
        if (next.tokens <= budget) statesAt[edge.end].push(next);
      }
    }
  }
  const finalPruned = approximateContextStates(
    statesAt[limitedNodeCount],
    budget,
    options.frontierLimit ?? DEFAULT_CONTEXT_FRONTIER_LIMIT,
    options.tokenBucketSize ?? DEFAULT_CONTEXT_TOKEN_BUCKET_SIZE,
  );
  approximated ||= finalPruned.approximated;
  const states = finalPruned.states.sort((left, right) =>
    compareChainContextStates(right, left),
  );
  return {
    chainRootId: chain.nodes[0]?.id ?? "",
    outlineLevel: chain.outlineLevel,
    nodeIds: chain.nodes.slice(0, limitedNodeCount).map((node) => node.id),
    states,
    approximated,
  };
}

export function selectRecentRawContext(
  projection: ConversationNode[],
  recentRawNodeCount: number,
  availableTokens: number,
  cache: NodeSummaryRuntimeCache = createNodeSummaryRuntimeCache(),
): RecentRawContext & { startIndex: number } {
  const desiredCount = Math.max(0, Math.floor(recentRawNodeCount));
  let startIndex = Math.max(0, projection.length - desiredCount);
  let selected = projection.slice(startIndex);
  let tokens = selected.reduce(
    (total, node) => total + cache.getNodeTokens(node),
    0,
  );
  while (selected.length > 0 && tokens > Math.max(0, availableTokens)) {
    tokens -= cache.getNodeTokens(selected[0]);
    startIndex += 1;
    selected = projection.slice(startIndex);
  }
  return {
    startIndex,
    tokens,
    nodeIds: selected.map((node) => node.id),
    representations: selected.map((node) => ({
      kind: "raw" as const,
      nodeId: node.id,
    })),
  };
}

export function planChainContextFrontiers(
  args: PlanChainContextArgs,
): ChainContextPlanningResult {
  const cache = args.cache ?? createNodeSummaryRuntimeCache();
  const recentRaw = selectRecentRawContext(
    args.projection,
    args.recentRawNodeCount,
    args.availableTokens,
    cache,
  );
  const optionalProjection = args.projection.slice(0, recentRaw.startIndex);
  const optionalIds = new Set(optionalProjection.map((node) => node.id));
  const allChains = partitionProjectionIntoOutlineChains(args.projection);
  const optionalBudget = Math.max(0, args.availableTokens - recentRaw.tokens);
  const chains = allChains.flatMap((chain) => {
    const nodeCount = chain.nodes.findIndex(
      (node) => !optionalIds.has(node.id),
    );
    const prefixLength = nodeCount < 0 ? chain.nodes.length : nodeCount;
    return prefixLength > 0
      ? [
          planOutlineChainContext(
            chain,
            allChains,
            prefixLength,
            optionalBudget,
            cache,
            args,
          ),
        ]
      : [];
  });
  return {
    recentRaw: {
      tokens: recentRaw.tokens,
      nodeIds: recentRaw.nodeIds,
      representations: recentRaw.representations,
    },
    optionalBudget,
    optionalNodeIds: optionalProjection.map((node) => node.id),
    chains,
  };
}

export function planNodeConversationContext(
  args: PlanNodeConversationContextArgs,
): NodeConversationContextPlan {
  const planning = planChainContextFrontiers(args);
  const combined = combineChainContextFrontiers(
    planning.chains,
    planning.optionalBudget,
    args,
  );
  const optionalState = bestState(
    combined.states.length > 0 ? combined.states : [emptyChainContextState()],
    compareChainContextStates,
  );
  const recentState: ChainContextState = {
    tokens: planning.recentRaw.tokens,
    coveredNodeCount: planning.recentRaw.nodeIds.length,
    freshCoveredNodeCount: planning.recentRaw.nodeIds.length,
    rawCoveredNodeCount: planning.recentRaw.nodeIds.length,
    segmentCoveredNodeCount: 0,
    checkpointCoveredNodeCount: 0,
    selectedRepresentations: planning.recentRaw.representations,
  };
  const state = combineContextStates(optionalState, recentState);

  return {
    tokens: state.tokens,
    representations: state.selectedRepresentations,
    recentRaw: planning.recentRaw,
    state,
    diagnostics: combined.diagnostics,
  };
}

export function combineChainContextFrontiers(
  chains: OutlineChainContextFrontier[],
  tokenBudget: number,
  options: ContextParetoOptions = {},
): CombinedContextFrontier {
  const frontierLimit = options.frontierLimit ?? DEFAULT_CONTEXT_FRONTIER_LIMIT;
  const tokenBucketSize =
    options.tokenBucketSize ?? DEFAULT_CONTEXT_TOKEN_BUCKET_SIZE;
  let frontier = [emptyChainContextState()];
  let approximated = chains.some((chain) => chain.approximated);
  let maxCandidateCount = frontier.length;

  for (const chain of chains) {
    let candidates: ChainContextState[] = [];
    let stepApproximated = false;
    const batchLimit = Math.max(64, Math.max(3, frontierLimit) * 4);
    for (const accumulated of frontier) {
      for (const chainState of chain.states) {
        const combined = combineContextStates(accumulated, chainState);
        if (combined.tokens <= Math.max(0, tokenBudget)) {
          candidates.push(combined);
          if (candidates.length >= batchLimit) {
            maxCandidateCount = Math.max(maxCandidateCount, candidates.length);
            const batched = approximateContextStates(
              candidates,
              tokenBudget,
              frontierLimit,
              tokenBucketSize,
            );
            candidates = batched.states;
            stepApproximated ||= batched.approximated;
          }
        }
      }
    }
    maxCandidateCount = Math.max(maxCandidateCount, candidates.length);
    const pruned = approximateContextStates(
      candidates,
      tokenBudget,
      frontierLimit,
      tokenBucketSize,
    );
    frontier = pruned.states;
    approximated ||= stepApproximated || pruned.approximated;
  }
  return {
    states: frontier,
    diagnostics: {
      approximated,
      maxCandidateCount,
      finalFrontierSize: frontier.length,
      chainCount: chains.length,
    },
  };
}
