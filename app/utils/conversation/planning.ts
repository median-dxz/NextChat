import { estimateRequestMessageTokens } from "../context-budget";
import { estimateTokenLength } from "../token";
import { createSourceDigest, type ConversationNode, type NodeSummary } from "./node";
import {
  createSummarySnapshot,
  evaluateNodeSummary,
  partitionProjectionIntoOutlineChains,
  type CheckpointGenerationInput,
  type CheckpointMaintenancePlan,
  type NodeSummaryEvaluation,
  type NodeSummaryFreshness,
  type OutlineChain,
  type SegmentGenerationBackground,
  type SegmentMaintenancePlan,
} from "./summary";

export type {
  CheckpointGenerationInput,
  CheckpointMaintenancePlan,
  NodeSummaryEvaluation,
  NodeSummaryFreshness,
  OutlineChain,
  SegmentGenerationBackground,
  SegmentMaintenancePlan,
} from "./summary";

interface NodeSummaryRuntimeCache {
  getNodeTokens(node: ConversationNode): number;
  getSummaryTokens(content: string): number;
  getSourceDigest(nodes: ConversationNode[]): string;
}

export interface PlanSegmentMaintenanceArgs {
  projection: ConversationNode[];
  targetId: string;
  sourceTokenTarget: number;
  maxSourceNodes: number;
  inputBudget: number;
  force?: boolean;
}

export interface PlanCheckpointMaintenanceArgs {
  projection: ConversationNode[];
  targetId: string;
  targetSegments: number;
  mergeTokenTarget: number;
  inputBudget: number;
  force?: boolean;
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

interface ChainContextState {
  tokens: number;
  coveredNodeCount: number;
  freshCoveredNodeCount: number;
  rawCoveredNodeCount: number;
  segmentCoveredNodeCount: number;
  checkpointCoveredNodeCount: number;
  selectedRepresentations: ContextRepresentation[];
}

interface OutlineChainContextFrontier {
  states: ChainContextState[];
  approximated: boolean;
}

interface RecentRawContext {
  tokens: number;
  representations: ContextRepresentation[];
}

interface ChainContextPlanningResult {
  recentRaw: RecentRawContext;
  optionalBudget: number;
  chains: OutlineChainContextFrontier[];
}

interface PlanChainContextArgs {
  projection: ConversationNode[];
  recentRawNodeCount: number;
  availableTokens: number;
  includeSummaries: boolean;
  frontierLimit?: number;
  tokenBucketSize?: number;
}

interface ContextParetoOptions {
  frontierLimit?: number;
  tokenBucketSize?: number;
}

export interface ContextPlanningDiagnostics {
  approximated: boolean;
  maxCandidateCount: number;
  finalFrontierSize: number;
  chainCount: number;
}

interface CombinedContextFrontier {
  states: ChainContextState[];
  diagnostics: ContextPlanningDiagnostics;
}

interface NodeConversationContextPlan {
  tokens: number;
  representations: ContextRepresentation[];
  diagnostics: ContextPlanningDiagnostics;
}

function summaryDigestValue(node: ConversationNode) {
  return [node.id, node.role, node.content];
}

function createNodeSummaryRuntimeCache(): NodeSummaryRuntimeCache {
  const nodeTokens = new Map<string, number>();
  const summaryTokens = new Map<string, number>();
  const digests = new Map<string, string>();

  return {
    getNodeTokens(node) {
      const key = JSON.stringify([node.id, node.role, node.content]);
      const cached = nodeTokens.get(key);
      if (cached !== undefined) return cached;
      const tokens = estimateRequestMessageTokens(node);
      nodeTokens.set(key, tokens);
      return tokens;
    },
    getSummaryTokens(content) {
      const cached = summaryTokens.get(content);
      if (cached !== undefined) return cached;
      const tokens = estimateTokenLength(content);
      summaryTokens.set(content, tokens);
      return tokens;
    },
    getSourceDigest(nodes) {
      const key = JSON.stringify(nodes.map(summaryDigestValue));
      const cached = digests.get(key);
      if (cached !== undefined) return cached;
      const digest = createSourceDigest(nodes);
      digests.set(key, digest);
      return digest;
    },
  };
}

interface SummaryInterval {
  start: number;
  end: number;
  owner: ConversationNode;
  summary: NodeSummary;
  evaluation: NodeSummaryEvaluation;
}

function collectSummaryIntervals(
  chain: OutlineChain,
  chains: OutlineChain[],
  kind: "segment" | "checkpoint",
) {
  const positions = new Map(chain.nodes.map((node, index) => [node.id, index]));
  return chain.nodes.flatMap((owner): SummaryInterval[] => {
    const summary = owner.nodeSummaries?.[kind];
    if (!summary) return [];
    const evaluation = evaluateNodeSummary(owner, kind, summary, chains);
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
  const projectionOrder = new Map(projection.map((node, index) => [node.id, index]));
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
      snapshot: createSummarySnapshot(summary),
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
      projectionOrder.get(left.endpointNodeId)! - projectionOrder.get(right.endpointNodeId)!,
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
  const sourceTokens = sourceNodes.reduce((tokens, node) => tokens + cache.getNodeTokens(node), 0);
  if (sourceTokens > inputBudget) return;
  const sourceStartIndex = targetChain.nodes.findIndex((node) => node.id === sourceNodes[0].id);
  return {
    kind: "segment",
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

function planSegmentMaintenance(
  args: PlanSegmentMaintenanceArgs,
): SegmentMaintenancePlan | undefined {
  const target = args.projection.find((node) => node.id === args.targetId);
  if (!target || target.role !== "assistant") return;
  const chains = partitionProjectionIntoOutlineChains(args.projection);
  const targetChain = chains.find((chain) => chain.nodes.some((node) => node.id === target.id));
  if (!targetChain) return;
  const targetIndex = targetChain.nodes.findIndex((node) => node.id === target.id);
  const cache = createNodeSummaryRuntimeCache();
  const intervals = collectSummaryIntervals(targetChain, chains, "segment")
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (args.force && target.nodeSummaries?.segment) {
    const current = target.nodeSummaries.segment;
    const evaluation = evaluateNodeSummary(target, "segment", current, chains);
    const sourceNodes = evaluation.structurallyEligible ? evaluation.sourceNodes : [target];
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
      interval.summary.provenance === "generated" && interval.evaluation.freshness === "stale",
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
  const sourceTokens = sourceNodes.reduce((tokens, node) => tokens + cache.getNodeTokens(node), 0);
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

function collectFreshSegmentsForRange(intervals: SummaryInterval[], start: number, end: number) {
  const selected: SummaryInterval[] = [];
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
  base: SummaryInterval | undefined,
  segments: SummaryInterval[],
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
      snapshot: createSummarySnapshot(base.summary),
    });
  }
  for (const segment of segments) {
    inputs.push({
      kind: "segment",
      ownerNodeId: segment.owner.id,
      content: segment.summary.content,
      tokens: cache.getSummaryTokens(segment.summary.content),
      snapshot: createSummarySnapshot(segment.summary),
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
    kind: "checkpoint",
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

function planCheckpointMaintenance(
  args: PlanCheckpointMaintenanceArgs,
): CheckpointMaintenancePlan | undefined {
  const target = args.projection.find((node) => node.id === args.targetId);
  if (!target || target.role !== "assistant") return;
  const chains = partitionProjectionIntoOutlineChains(args.projection);
  const targetChain = chains.find((chain) => chain.nodes.some((node) => node.id === target.id));
  if (!targetChain) return;
  const targetIndex = targetChain.nodes.findIndex((node) => node.id === target.id);
  const cache = createNodeSummaryRuntimeCache();
  const segments = collectSummaryIntervals(targetChain, chains, "segment")
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const checkpoints = collectSummaryIntervals(targetChain, chains, "checkpoint")
    .filter((checkpoint) => checkpoint.end <= targetIndex)
    .sort((left, right) => left.end - right.end);

  const forcedSummary = args.force ? target.nodeSummaries?.checkpoint : undefined;
  const staleGenerated = checkpoints.find(
    (checkpoint) =>
      checkpoint.summary.provenance === "generated" && checkpoint.evaluation.freshness === "stale",
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
        (checkpoint) => checkpoint.end < refresh.end && checkpoint.evaluation.freshness === "fresh",
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
  const continuous: SummaryInterval[] = [];
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
      (tokens, segment) => tokens + cache.getSummaryTokens(segment.summary.content),
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

function compareChainContextStates(left: ChainContextState, right: ChainContextState) {
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

function chainStateDominates(left: ChainContextState, right: ChainContextState) {
  return left.tokens <= right.tokens && compareChainContextStates(left, right) > 0;
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
    (left, right) => left.tokens - right.tokens || compareChainContextStates(right, left),
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
    freshCoveredNodeCount: left.freshCoveredNodeCount + right.freshCoveredNodeCount,
    rawCoveredNodeCount: left.rawCoveredNodeCount + right.rawCoveredNodeCount,
    segmentCoveredNodeCount: left.segmentCoveredNodeCount + right.segmentCoveredNodeCount,
    checkpointCoveredNodeCount: left.checkpointCoveredNodeCount + right.checkpointCoveredNodeCount,
    selectedRepresentations: [...left.selectedRepresentations, ...right.selectedRepresentations],
  };
}

function compareFidelityVector(left: ChainContextState, right: ChainContextState) {
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
  return states.reduce((best, candidate) => (compare(candidate, best) > 0 ? candidate : best));
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
    freshCoveredNodeCount: state.freshCoveredNodeCount + edge.freshCoveredNodeCount,
    rawCoveredNodeCount: state.rawCoveredNodeCount + edge.rawCoveredNodeCount,
    segmentCoveredNodeCount: state.segmentCoveredNodeCount + edge.segmentCoveredNodeCount,
    checkpointCoveredNodeCount: state.checkpointCoveredNodeCount + edge.checkpointCoveredNodeCount,
    selectedRepresentations: [...state.selectedRepresentations, edge.representation],
  };
}

function buildChainContextEdges(
  chain: OutlineChain,
  allChains: OutlineChain[],
  nodeCount: number,
  cache: NodeSummaryRuntimeCache,
  includeSummaries: boolean,
) {
  const positions = new Map(chain.nodes.map((node, index) => [node.id, index]));
  const edges = Array.from({ length: nodeCount }, () => [] as ChainContextEdge[]);
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
  if (includeSummaries) {
    for (const owner of chain.nodes.slice(0, nodeCount)) {
      for (const kind of ["segment", "checkpoint"] as const) {
        const summary = owner.nodeSummaries?.[kind];
        if (!summary) continue;
        const evaluation = evaluateNodeSummary(owner, kind, summary, allChains);
        if (!evaluation.structurallyEligible || !evaluation.freshness) continue;
        const start = positions.get(evaluation.sourceNodes[0].id);
        const end = positions.get(evaluation.sourceNodes.at(-1)!.id);
        if (start === undefined || end === undefined || end >= nodeCount) {
          continue;
        }
        const coveredNodeCount = end - start + 1;
        edges[start].push({
          end: end + 1,
          tokens: cache.getSummaryTokens(summary.content),
          coveredNodeCount,
          freshCoveredNodeCount: evaluation.freshness === "fresh" ? coveredNodeCount : 0,
          rawCoveredNodeCount: 0,
          segmentCoveredNodeCount: kind === "segment" ? coveredNodeCount : 0,
          checkpointCoveredNodeCount: kind === "checkpoint" ? coveredNodeCount : 0,
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
  }
  return edges;
}

function planOutlineChainContext(
  chain: OutlineChain,
  allChains: OutlineChain[],
  nodeCount: number,
  tokenBudget: number,
  cache: NodeSummaryRuntimeCache,
  includeSummaries: boolean,
  options: ContextParetoOptions = {},
): OutlineChainContextFrontier {
  const limitedNodeCount = Math.max(0, Math.min(nodeCount, chain.nodes.length));
  const budget = Math.max(0, tokenBudget);
  const edges = buildChainContextEdges(chain, allChains, limitedNodeCount, cache, includeSummaries);
  const statesAt = Array.from({ length: limitedNodeCount + 1 }, () => [] as ChainContextState[]);
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
  const states = finalPruned.states.sort((left, right) => compareChainContextStates(right, left));
  return {
    states,
    approximated,
  };
}

function selectRecentRawContext(
  projection: ConversationNode[],
  recentRawNodeCount: number,
  availableTokens: number,
  cache: NodeSummaryRuntimeCache = createNodeSummaryRuntimeCache(),
): RecentRawContext & { startIndex: number } {
  const desiredCount = Math.max(0, Math.floor(recentRawNodeCount));
  let startIndex = Math.max(0, projection.length - desiredCount);
  let selected = projection.slice(startIndex);
  let tokens = selected.reduce((total, node) => total + cache.getNodeTokens(node), 0);
  while (selected.length > 0 && tokens > Math.max(0, availableTokens)) {
    tokens -= cache.getNodeTokens(selected[0]);
    startIndex += 1;
    selected = projection.slice(startIndex);
  }
  return {
    startIndex,
    tokens,
    representations: selected.map((node) => ({
      kind: "raw" as const,
      nodeId: node.id,
    })),
  };
}

function planChainContextFrontiers(args: PlanChainContextArgs): ChainContextPlanningResult {
  const cache = createNodeSummaryRuntimeCache();
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
    const nodeCount = chain.nodes.findIndex((node) => !optionalIds.has(node.id));
    const prefixLength = nodeCount < 0 ? chain.nodes.length : nodeCount;
    return prefixLength > 0
      ? [
          planOutlineChainContext(
            chain,
            allChains,
            prefixLength,
            optionalBudget,
            cache,
            args.includeSummaries,
            args,
          ),
        ]
      : [];
  });
  return {
    recentRaw: {
      tokens: recentRaw.tokens,
      representations: recentRaw.representations,
    },
    optionalBudget,
    chains,
  };
}

export function planNodeConversationContext(
  args: PlanChainContextArgs,
): NodeConversationContextPlan {
  const planning = planChainContextFrontiers(args);
  const combined = combineChainContextFrontiers(planning.chains, planning.optionalBudget, args);
  const optionalState = bestState(
    combined.states.length > 0 ? combined.states : [emptyChainContextState()],
    compareChainContextStates,
  );
  const recentState: ChainContextState = {
    tokens: planning.recentRaw.tokens,
    coveredNodeCount: planning.recentRaw.representations.length,
    freshCoveredNodeCount: planning.recentRaw.representations.length,
    rawCoveredNodeCount: planning.recentRaw.representations.length,
    segmentCoveredNodeCount: 0,
    checkpointCoveredNodeCount: 0,
    selectedRepresentations: planning.recentRaw.representations,
  };
  const state = combineContextStates(optionalState, recentState);

  return {
    tokens: state.tokens,
    representations: state.selectedRepresentations,
    diagnostics: combined.diagnostics,
  };
}

function combineChainContextFrontiers(
  chains: OutlineChainContextFrontier[],
  tokenBudget: number,
  options: ContextParetoOptions = {},
): CombinedContextFrontier {
  const frontierLimit = options.frontierLimit ?? DEFAULT_CONTEXT_FRONTIER_LIMIT;
  const tokenBucketSize = options.tokenBucketSize ?? DEFAULT_CONTEXT_TOKEN_BUCKET_SIZE;
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

export interface ConversationPlanningApi {
  readonly chainRootId: string | undefined;
  segment(
    options: Omit<PlanSegmentMaintenanceArgs, "projection" | "targetId" | "cache">,
  ): SegmentMaintenancePlan | undefined;
  checkpoint(
    options: Omit<PlanCheckpointMaintenanceArgs, "projection" | "targetId" | "cache">,
  ): CheckpointMaintenancePlan | undefined;
}

export function ConversationPlanning(
  projection: ConversationNode[],
  targetNodeId: string,
): ConversationPlanningApi {
  const targetChain = partitionProjectionIntoOutlineChains(projection).find((chain) =>
    chain.nodes.some((node) => node.id === targetNodeId),
  );
  return {
    chainRootId: targetChain?.nodes[0].id,
    segment: (options) =>
      planSegmentMaintenance({
        projection,
        targetId: targetNodeId,
        ...options,
      }),
    checkpoint: (options) =>
      planCheckpointMaintenance({
        projection,
        targetId: targetNodeId,
        ...options,
      }),
  };
}
