import {
  createNodeSummarySourceDigest,
  type ConversationNode,
  type NodeSummaryKind,
} from "./conversation-graph";
import type { NodeSummary } from "./conversation-graph";
import type {
  ContextProjection,
  ConversationSummary,
} from "./context-compression";
import {
  estimateRequestMessageTokens,
  getCompleteTurns,
  getContextInputBudget,
  isSummaryCurrent,
} from "./context-compression";
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

export interface NodeSummarySourcePlan {
  kind: NodeSummaryKind;
  sourceNodeIds: string[];
  inputNodes: ConversationNode[];
}

export function planNodeSummarySource(
  projection: ConversationNode[],
  targetId: string,
  inputBudget: number,
  compressionThreshold: number,
): NodeSummarySourcePlan | undefined {
  const targetIndex = projection.findIndex((node) => node.id === targetId);
  const target = projection[targetIndex];
  if (targetIndex < 0 || !target || target.role !== "assistant") return;

  const visible = projection
    .slice(0, targetIndex + 1)
    .filter((node) => node.outlineLevel <= target.outlineLevel);
  const inputNodes: ConversationNode[] = [];
  let tokens = 0;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const node = visible[index];
    const nextTokens = estimateRequestMessageTokens(node);
    if (inputNodes.length > 0 && tokens + nextTokens > inputBudget) break;
    inputNodes.unshift(node);
    tokens += nextTokens;
  }
  const sourceNodeIds = inputNodes
    .filter((node) => node.outlineLevel === target.outlineLevel)
    .map((node) => node.id);
  if (sourceNodeIds.length === 0) return;

  const assistantCount = visible.filter(
    (node) =>
      node.role === "assistant" && node.outlineLevel === target.outlineLevel,
  ).length;
  const kind: NodeSummaryKind =
    assistantCount % 6 === 0 || tokens >= compressionThreshold * 4
      ? "checkpoint"
      : "segment";
  return { kind, sourceNodeIds, inputNodes };
}

export function materializeNodeSummaries(
  projection: ConversationNode[],
): ConversationSummary[] {
  const chains = partitionProjectionIntoOutlineChains(projection);
  return projection.flatMap((node) =>
    Object.entries(node.nodeSummaries ?? {}).flatMap(([kind, summary]) => {
      if (!summary) return [];
      const evaluation = evaluateNodeSummary(
        node,
        kind as NodeSummaryKind,
        summary,
        chains,
      );
      if (
        !evaluation.structurallyEligible ||
        evaluation.sourceNodes.some((source) => source.hidden)
      )
        return [];
      return [
        {
          id: `node-summary:${node.id}:${kind}`,
          kind: kind as NodeSummaryKind,
          content: summary.content,
          sourceEntryIds: summary.sourceNodeIds,
          sourceDigest: summary.sourceDigest,
          inputSummaryIds: [],
          stable: true,
        },
      ];
    }),
  );
}

interface FrontierState {
  tokens: number;
  coverage: number;
  fidelity: number;
  selectedSummaryIds: string[];
  selectedMessageIds: string[];
  coveredIds: Set<string>;
}

interface Representation {
  id: string;
  kind: "raw" | NodeSummaryKind;
  tokens: number;
  sourceIds: string[];
}

const MAX_FRONTIER_STATES = 512;

function dominates(left: FrontierState, right: FrontierState) {
  return (
    left.tokens <= right.tokens &&
    left.coverage >= right.coverage &&
    left.fidelity >= right.fidelity &&
    (left.tokens < right.tokens ||
      left.coverage > right.coverage ||
      left.fidelity > right.fidelity)
  );
}

function rankStates(left: FrontierState, right: FrontierState) {
  return (
    right.coverage - left.coverage ||
    right.fidelity - left.fidelity ||
    left.tokens - right.tokens
  );
}

function pruneFrontier(states: FrontierState[]) {
  const sorted = states.sort(rankStates);
  const frontier: FrontierState[] = [];
  for (const candidate of sorted) {
    if (frontier.some((state) => dominates(state, candidate))) continue;
    frontier.push(candidate);
    if (frontier.length >= MAX_FRONTIER_STATES) break;
  }
  return frontier;
}

export function planNodeConversationContext(args: {
  projection: ContextProjection<ConversationNode>;
  summaries: ConversationSummary[];
  historyMessageCount: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  fixedTokenCount: number;
  currentInputTokenCount: number;
}) {
  const inputBudget = getContextInputBudget(
    args.contextWindowTokens,
    args.maxOutputTokens,
  );
  const availableBudget = Math.max(
    0,
    inputBudget - args.fixedTokenCount - args.currentInputTokenCount,
  );
  const entries = args.projection.entries;
  const completeTurns = getCompleteTurns(entries, true);
  const recentTurns: ConversationNode[][] = [];
  let recentMessageCount = 0;
  for (let index = completeTurns.length - 1; index >= 0; index -= 1) {
    if (recentMessageCount >= args.historyMessageCount) break;
    recentTurns.unshift(completeTurns[index]);
    recentMessageCount += completeTurns[index].length;
  }
  let mandatoryRecent = recentTurns.flat();
  let mandatoryTokens = mandatoryRecent.reduce(
    (sum, node) => sum + estimateRequestMessageTokens(node),
    0,
  );
  while (mandatoryRecent.length > 0 && mandatoryTokens > availableBudget) {
    const removedTurn = recentTurns.shift();
    if (!removedTurn) break;
    mandatoryTokens -= removedTurn.reduce(
      (sum, node) => sum + estimateRequestMessageTokens(node),
      0,
    );
    mandatoryRecent = recentTurns.flat();
  }
  const recentStart = mandatoryRecent.length
    ? entries.findIndex((node) => node.id === mandatoryRecent[0].id)
    : entries.length;
  const selectedMessageIds = mandatoryRecent.map((node) => node.id);
  const mandatoryCovered = new Set(
    mandatoryRecent.filter((node) => !node.hidden).map((node) => node.id),
  );
  const optionalBudget = Math.max(0, availableBudget - mandatoryTokens);
  const optionalIds = new Set(
    entries.slice(0, recentStart).map((node) => node.id),
  );
  const hiddenIds = new Set(
    entries.filter((node) => node.hidden).map((node) => node.id),
  );
  const optionalTurns = getCompleteTurns(entries.slice(0, recentStart), true);
  const representations: Representation[] = [
    ...optionalTurns.map((turn) => ({
      id: `raw-turn:${turn.map((node) => node.id).join(":")}`,
      kind: "raw" as const,
      tokens: turn.reduce(
        (sum, node) => sum + estimateRequestMessageTokens(node),
        0,
      ),
      sourceIds: turn.map((node) => node.id),
    })),
    ...args.summaries
      .filter((summary) => isSummaryCurrent(summary, args.projection))
      .filter((summary) =>
        summary.sourceEntryIds.every(
          (id) => optionalIds.has(id) && !hiddenIds.has(id),
        ),
      )
      .map((summary) => ({
        id: summary.id,
        kind: summary.kind,
        tokens: estimateTokenLength(summary.content),
        sourceIds: summary.sourceEntryIds,
      }))
      .filter((summary) => summary.sourceIds.length > 0),
  ];

  let frontier: FrontierState[] = [
    {
      tokens: 0,
      coverage: 0,
      fidelity: 0,
      selectedSummaryIds: [],
      selectedMessageIds: [],
      coveredIds: new Set(),
    },
  ];
  for (const representation of representations) {
    const fidelity =
      representation.kind === "raw"
        ? 3
        : representation.kind === "segment"
          ? 2
          : 1;
    const additions: FrontierState[] = [];
    for (const state of frontier) {
      if (state.tokens + representation.tokens > optionalBudget) continue;
      if (representation.sourceIds.some((id) => state.coveredIds.has(id))) {
        continue;
      }
      const coveredIds = new Set(state.coveredIds);
      representation.sourceIds.forEach((id) => coveredIds.add(id));
      additions.push({
        tokens: state.tokens + representation.tokens,
        coverage: state.coverage + representation.sourceIds.length,
        fidelity: state.fidelity + fidelity * representation.sourceIds.length,
        selectedSummaryIds:
          representation.kind === "raw"
            ? state.selectedSummaryIds
            : [...state.selectedSummaryIds, representation.id],
        selectedMessageIds:
          representation.kind === "raw"
            ? [...state.selectedMessageIds, ...representation.sourceIds]
            : state.selectedMessageIds,
        coveredIds,
      });
    }
    frontier = pruneFrontier([...frontier, ...additions]);
  }

  const best = frontier.sort(rankStates)[0];
  const order = new Map(entries.map((node, index) => [node.id, index]));
  const optionalMessageIds = best.selectedMessageIds.sort(
    (left, right) => order.get(left)! - order.get(right)!,
  );
  const coveredCount = new Set([...mandatoryCovered, ...best.coveredIds]).size;
  return {
    selectedSummaryIds: best.selectedSummaryIds,
    selectedMessageIds: [...optionalMessageIds, ...selectedMessageIds],
    requiresCompaction: coveredCount < entries.length,
    overflow: args.fixedTokenCount + args.currentInputTokenCount > inputBudget,
  };
}
