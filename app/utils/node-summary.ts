import type { ConversationNode, NodeSummaryKind } from "./conversation-graph";
import type {
  ContextProjection,
  ConversationSummary,
} from "./context-compression";
import {
  estimateRequestMessageTokens,
  getContextInputBudget,
} from "./context-compression";
import { estimateTokenLength } from "./token";

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
  const projectedIds = new Set(projection.map((node) => node.id));
  return projection.flatMap((node) =>
    Object.entries(node.nodeSummaries ?? {}).flatMap(([kind, summary]) => {
      if (
        !summary ||
        !summary.sourceNodeIds.every((id) => projectedIds.has(id))
      ) {
        return [];
      }
      return [
        {
          id: `node-summary:${node.id}:${kind}`,
          kind: kind as NodeSummaryKind,
          content: summary.content,
          sourceEntryIds: summary.sourceNodeIds,
          sourceDigest: "",
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
  const recentStart = Math.max(0, entries.length - args.historyMessageCount);
  const mandatoryRecent = entries.slice(recentStart);
  const selectedMessageIds = mandatoryRecent.map((node) => node.id);
  const mandatoryCovered = new Set(
    mandatoryRecent.filter((node) => !node.hidden).map((node) => node.id),
  );
  const mandatoryTokens = mandatoryRecent.reduce(
    (sum, node) => sum + estimateRequestMessageTokens(node),
    0,
  );
  const optionalBudget = Math.max(0, availableBudget - mandatoryTokens);
  const optionalIds = new Set(
    entries.slice(0, recentStart).map((node) => node.id),
  );
  const representations: Representation[] = [
    ...entries.slice(0, recentStart).map((node) => ({
      id: node.id,
      kind: "raw" as const,
      tokens: estimateRequestMessageTokens(node),
      sourceIds: [node.id],
    })),
    ...args.summaries
      .filter((summary) => summary.sourceEntryIds.length > 0)
      .filter((summary) =>
        summary.sourceEntryIds.every(
          (id) => optionalIds.has(id) || !mandatoryCovered.has(id),
        ),
      )
      .map((summary) => ({
        id: summary.id,
        kind: summary.kind,
        tokens: estimateTokenLength(summary.content),
        sourceIds: summary.sourceEntryIds.filter((id) => optionalIds.has(id)),
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
            ? [...state.selectedMessageIds, representation.id]
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
